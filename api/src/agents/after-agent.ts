import { z } from 'zod';
import type { BaseMessage } from '@langchain/core/messages';
import type { WikiEntry } from '@tkottke90/llm-wiki';
import { createProvider } from '../services/provider-factory.js';
import { getWikiRegistry } from '../services/wiki.js';
import { getObservabilityStore } from '../services/observability.js';
import { ObservabilityCallbackHandler } from './observability-handler.js';
import { env } from '../config/env.js';
import { logger, serializeError } from '../config/logger.js';

// ---------------------------------------------------------------------------
// Per-thread state — in-memory, process-lifetime. Consistent with the
// existing _agents cache (chat-agent.ts) and artifact-store.ts precedent;
// real eviction is deferred to the "Persistent Conversation Memory" item.
// ---------------------------------------------------------------------------

const threadState = new Map<string, { rollingSummary: string }>();

export interface WikiUpdatedEvent {
  type: 'wiki_updated';
  pageTitle: string;
  pageKind: string;
  wikiName: string;
}

const pendingWikiUpdates = new Map<string, WikiUpdatedEvent[]>();

/** Pops and returns any queued wiki_updated events for a thread. Called by
 * stream-handler.ts at the start of each turn to flush the previous turn's
 * background writes. */
export function drainPendingWikiUpdates(threadId: string): WikiUpdatedEvent[] {
  const events = pendingWikiUpdates.get(threadId) ?? [];
  pendingWikiUpdates.delete(threadId);
  return events;
}

function queueWikiUpdate(threadId: string, event: WikiUpdatedEvent): void {
  const events = pendingWikiUpdates.get(threadId) ?? [];
  events.push(event);
  pendingWikiUpdates.set(threadId, events);
}

// ---------------------------------------------------------------------------
// Context schema — consumed by the afterAgent middleware in chat-agent.ts.
// Every field is optional so `context` is an optional argument at the
// streamEvents() call site.
// ---------------------------------------------------------------------------

const AfterAgentContextSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  afterAgentEnabled: z.boolean().optional(),
});

export function getAfterAgentContextSchema() {
  return AfterAgentContextSchema;
}

// ---------------------------------------------------------------------------
// Pipeline step schemas
// ---------------------------------------------------------------------------

const SummarizeOutputSchema = z.object({
  summary: z.string().describe('Updated rolling summary of the conversation, in plain prose.'),
});

const ClassifyOutputSchema = z.object({
  shouldWrite: z
    .boolean()
    .describe('True if this turn contains novel, durable knowledge worth saving to the wiki.'),
  reason: z.string().describe('One sentence explaining the decision.'),
});

// 'index' and 'log' are deliberately excluded: llm-wiki's TYPE_DIR maps both
// to the wiki root, which would collide with the wiki's real index.md/log.md.
const ExtractOutputSchema = z.object({
  domainId: z.string().describe('The id of the wiki domain this content belongs in.'),
  type: z.enum(['entity', 'concept', 'comparison', 'query', 'summary']),
  title: z.string(),
  tags: z.array(z.string()),
  body: z.string().describe('Page body as markdown (no frontmatter).'),
  summary: z.string().optional().describe('One-line summary for the wiki index entry.'),
});

const MergeOutputSchema = z.object({
  body: z
    .string()
    .describe('The merged page body as markdown, combining the existing and new content.'),
});

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildSummarizePrompt(priorSummary: string, turnText: string): string {
  return [
    'You maintain a rolling summary of an ongoing conversation between a user and an AI assistant.',
    'Fold the latest turn into the existing summary. Preserve every fact already present unless the',
    'latest turn explicitly corrects or supersedes it. Keep the summary concise — a few sentences per',
    'distinct fact, not a transcript. Do not editorialize or add facts that were not stated.',
    '',
    priorSummary
      ? `Existing summary:\n${priorSummary}`
      : 'Existing summary: (none — this is the first turn)',
    '',
    `Latest turn:\n${turnText}`,
    '',
    'Return the updated summary.',
  ].join('\n');
}

function buildClassifyPrompt(turnText: string, summary: string): string {
  return [
    'You decide whether a conversation turn contains novel, durable knowledge worth saving to a',
    'personal knowledge base (a wiki). Say yes only for facts about the user, their work, their',
    'projects, or corrections to previously known facts — not for general knowledge the assistant',
    'recites, questions the user asks, or small talk. If the fact is already covered by the summary',
    'below and the turn does not add or change anything, say no.',
    '',
    `Rolling summary of the conversation so far:\n${summary || '(none)'}`,
    '',
    `Latest turn:\n${turnText}`,
    '',
    'Decide whether this turn should be written to the wiki.',
  ].join('\n');
}

function buildExtractPrompt(turnText: string, summary: string, domains: WikiEntry[]): string {
  const domainList = domains
    .map((d) => `- id: "${d.id}" (domain: ${d.domain}, tags: [${d.tags.join(', ')}])`)
    .join('\n');

  return [
    'Extract a wiki page from the novel knowledge in this conversation turn.',
    '',
    'Choose the wiki domain this content belongs in from the list below — pick the one whose',
    'tags/domain best match the content.',
    `Available domains:\n${domainList}`,
    '',
    'Choose a type: "entity" for a specific person/place/thing/organization, "concept" for an',
    'explanation of an idea, "comparison" for content that contrasts two or more things,',
    '"query" for a captured question-and-answer, or "summary" for a higher-level rollup.',
    '',
    `Rolling summary of the conversation so far:\n${summary || '(none)'}`,
    '',
    `Latest turn:\n${turnText}`,
    '',
    'Return the domainId, type, a short title, relevant tags, and the page body as markdown.',
  ].join('\n');
}

function buildMergePrompt(existingBody: string, newBody: string): string {
  return [
    'Merge new information into an existing wiki page. Combine both into a single coherent page',
    'body: keep everything from the existing page that is still accurate, incorporate the new',
    'content, and do not repeat the same fact twice. If the new content contradicts or corrects the',
    'existing content, prefer the new content and note that it changed rather than presenting both',
    'as equally true.',
    '',
    `Existing page body:\n${existingBody}`,
    '',
    `New content to merge in:\n${newBody}`,
    '',
    'Return the merged page body as markdown.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Everything from (and including) the last human message to the end of the
 * message list — the "latest turn" the pipeline reasons about. */
export function extractLatestTurnText(messages: BaseMessage[]): string {
  let lastHumanIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.getType() === 'human') {
      lastHumanIdx = i;
      break;
    }
  }
  if (lastHumanIdx === -1) return '';

  return messages
    .slice(lastHumanIdx)
    .map((m) => `${m.getType()}: ${stringifyContent(m.content)}`)
    .join('\n');
}

function stringifyContent(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => ('text' in block ? block.text : `[${block.type ?? 'non-text content'}]`))
    .join(' ');
}

async function invokeStructured<T extends z.ZodTypeAny>(
  llm: ReturnType<typeof createProvider>,
  schema: T,
  prompt: string,
  handler: ObservabilityCallbackHandler,
  runName: string,
): Promise<z.infer<T>> {
  const chain = llm.withStructuredOutput(schema).withRetry({ stopAfterAttempt: 3 });
  return chain.invoke(prompt, { callbacks: [handler], runName }) as Promise<z.infer<T>>;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface RunAfterAgentPipelineParams {
  threadId: string;
  messages: BaseMessage[];
  provider?: string;
  model?: string;
  requestAfterAgentEnabled?: boolean;
}

export async function runAfterAgentPipeline(params: RunAfterAgentPipelineParams): Promise<void> {
  const { threadId, messages, provider, model, requestAfterAgentEnabled } = params;

  logger.info('AfterAgent triggered', { threadId });

  // Global kill switch wins even if a request tries to force it on.
  if (!env.afterAgent.enabled) return;
  if (requestAfterAgentEnabled === false) return;

  const turnText = extractLatestTurnText(messages);
  if (!turnText.trim()) return;

  const store = getObservabilityStore();
  const traceId = store.startTrace({
    threadId,
    provider: provider ?? env.defaultProvider,
    model: model ?? '',
    source: 'after-agent',
  });
  const handler = new ObservabilityCallbackHandler(
    traceId,
    store,
    env.observability.spanOutputPreviewChars,
  );

  try {
    const llm = createProvider(provider, model);
    const state = threadState.get(threadId) ?? { rollingSummary: '' };

    const { summary } = await invokeStructured(
      llm,
      SummarizeOutputSchema,
      buildSummarizePrompt(state.rollingSummary, turnText),
      handler,
      'after-agent:summarize',
    );
    state.rollingSummary = summary;
    threadState.set(threadId, state);

    const classify = await invokeStructured(
      llm,
      ClassifyOutputSchema,
      buildClassifyPrompt(turnText, state.rollingSummary),
      handler,
      'after-agent:classify',
    );
    if (!classify.shouldWrite) {
      logger.info('AfterAgent no-op', { threadId, reason: classify.reason });
      return;
    }

    const registry = await getWikiRegistry();
    const domains = registry.list();
    if (domains.length === 0) {
      logger.warn('after-agent: classify said shouldWrite but no wiki domains are registered', {
        threadId,
      });
      return;
    }

    const extract = await invokeStructured(
      llm,
      ExtractOutputSchema,
      buildExtractPrompt(turnText, state.rollingSummary, domains),
      handler,
      'after-agent:extract',
    );
    const domainEntry = domains.find((d) => d.id === extract.domainId);
    if (!domainEntry) {
      logger.warn('after-agent: extract returned an unknown domainId — skipping write', {
        threadId,
        domainId: extract.domainId,
        availableDomains: domains.map((d) => d.id),
      });
      return;
    }

    const wiki = await registry.load(domainEntry.id);
    const prep = await wiki.ingestPrep({ content: extract.body, keywords: extract.tags });

    // Provenance: always save a raw snapshot of the turn, tagged with threadId,
    // so every AfterAgent-written page traces back to the conversation it came from.
    const rawSource = await wiki.saveRawSource({
      content: turnText,
      sourceUrl: `conversation:${threadId}`,
      path: prep.suggestedRawPath,
      sha256: prep.sha256,
    });

    let finalBody = extract.body;
    let relPath: string | undefined;

    const existingMatch = prep.existingPages[0];
    if (existingMatch) {
      relPath = existingMatch;
      const existingPage = await wiki.readPage(existingMatch);
      const merged = await invokeStructured(
        llm,
        MergeOutputSchema,
        buildMergePrompt(existingPage.content, extract.body),
        handler,
        'after-agent:merge-page',
      );
      finalBody = merged.body;
    }

    const commitResult = await wiki.commitPage({
      type: extract.type,
      title: extract.title,
      tags: extract.tags,
      sources: [rawSource.path],
      body: finalBody,
      summary: extract.summary,
      relPath,
    });

    queueWikiUpdate(threadId, {
      type: 'wiki_updated',
      pageTitle: extract.title,
      pageKind: extract.type,
      wikiName: domainEntry.id,
    });

    // The pipeline extracts and commits exactly one page per turn today — no
    // batch/delete path exists yet — so these counts are always 0 or 1, but
    // the shape stays stable if that ever changes.
    logger.info('AfterAgent identified', {
      threadId,
      created: commitResult.created ? 1 : 0,
      updated: commitResult.created ? 0 : 1,
      deleted: 0,
      wikis: [domainEntry.id],
      path: commitResult.path,
      warnings: commitResult.warnings,
    });
  } catch (err) {
    logger.error('after-agent: pipeline error', { threadId, err: serializeError(err) });
    // Never throw — this must not surface back into the afterAgent hook.
  } finally {
    store.endTrace(traceId, {
      totalTokens: handler.totalInputTokens + handler.totalOutputTokens,
    });
  }
}
