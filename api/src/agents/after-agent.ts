import { z } from 'zod';
import type { BaseMessage } from '@langchain/core/messages';
import type { WikiEntry, WikiRegistry } from '@tkottke90/llm-wiki';
import type { AfterAgentState } from '@tkottke90/llm-common-types/chat';
import { createProvider } from '../services/provider-factory.js';
import { getWikiRegistry } from '../services/wiki.js';
import type { WorkspaceStore } from '../services/workspace-store.js';
import type { ThreadStore } from '../services/thread-store.js';
import { checkWikiWrite, resolveWikiWriteScope } from '../services/wiki-write-scope.js';
import {
  createWikiPage,
  updateWikiPage,
  type CreateWikiPageResult,
  type UpdateWikiPageResult,
} from '../services/wiki-write.js';
import { broadcast } from '../services/broadcast.js';
import { ObservabilityCallbackHandler } from './observability-handler.js';
import { resolveTurnModel, startTurnObservability } from './turn-observability.js';
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
  pageKind: 'created' | 'updated';
  wikiName: string;
  path: string;
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

/** Queues a wiki_updated event for a thread — exported for test seeding
 * (stream-handler.test.ts), alongside drainPendingWikiUpdates. */
export function queueWikiUpdate(threadId: string, event: WikiUpdatedEvent): void {
  const events = pendingWikiUpdates.get(threadId) ?? [];
  events.push(event);
  pendingWikiUpdates.set(threadId, events);
}

// ---------------------------------------------------------------------------
// Live status — lets the UI show a subtle "working in the background"
// indicator without any persistence. Same in-memory, process-lifetime
// precedent as threadState/pendingWikiUpdates above.
// ---------------------------------------------------------------------------

// Shape shared with the UI and the after_agent_state broadcast — see
// lib/llm-common-types/src/chat/broadcast-events.ts.
export type { AfterAgentState };

// Generous headroom so a thread-list fetch (e.g. the live-events reconnect
// reconciliation) still catches the outcome before it's swept — not a
// correctness requirement, just UX.
const DONE_TTL_MS = 60_000;

const afterAgentStatus = new Map<string, AfterAgentState>();

export function getAfterAgentState(threadId: string): AfterAgentState {
  const entry = afterAgentStatus.get(threadId);
  if (!entry) return { status: 'idle' };
  if (entry.status === 'done' && Date.now() - Date.parse(entry.finishedAt) > DONE_TTL_MS) {
    afterAgentStatus.delete(threadId);
    return { status: 'idle' };
  }
  return entry;
}

// The only writer of afterAgentStatus — every transition is also pushed over
// the live-events channel, which is what replaces the UI's old thread-list
// poll. The lazy 'done' -> 'idle' expiry in getAfterAgentState() is
// deliberately silent (see the after_agent_state schema comment).
function setAfterAgentState(threadId: string, state: AfterAgentState): void {
  afterAgentStatus.set(threadId, state);
  broadcast({ type: 'after_agent_state', threadId, state });
}

function setAfterAgentDone(threadId: string, outcome: 'identified' | 'no-op' | 'error'): void {
  setAfterAgentState(threadId, {
    status: 'done',
    outcome,
    finishedAt: new Date().toISOString(),
  });
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

// Exported for unit testing — verifies setNextSpanName() is actually called
// ahead of invoke(), which real Runnable chains have no other way to prove
// (see ObservabilityCallbackHandler.setNextSpanName's doc for why).
export async function invokeStructured<T extends z.ZodTypeAny>(
  llm: ReturnType<typeof createProvider>,
  schema: T,
  prompt: string,
  handler: ObservabilityCallbackHandler,
  runName: string,
): Promise<z.infer<T>> {
  const chain = llm.withStructuredOutput(schema).withRetry({ stopAfterAttempt: 3 });
  // RunnableConfig's runName only labels the outer chain run, not the inner
  // LLM call this handler actually observes — see setNextSpanName()'s doc.
  handler.setNextSpanName(runName);
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
  // Test-only escape hatch: an already-constructed model, used in place of
  // createProvider(provider, model). Production callers never set this.
  llm?: ReturnType<typeof createProvider>;
  // Test-only escape hatch: an already-constructed registry, used in place
  // of getWikiRegistry(). Production callers never set this — needed to
  // exercise the real write-dispatch path (createWikiPage/updateWikiPage)
  // against a temp wiki instead of the real config/kb singleton.
  registry?: WikiRegistry;
  // Test-only escape hatch, same rationale as `registry` above — createWikiPage/
  // updateWikiPage's archived-domain check (R11) reads project status via
  // WorkspaceStore, which in production is the process-wide getWorkspaceStore()
  // singleton (booted once at server start). Production callers never set this.
  store?: WorkspaceStore;
  // The run's server-set configurable.workspaceId, when it has one — the
  // most reliable way to place the turn in its workspace (see
  // services/wiki-write-scope.ts).
  workspaceId?: string;
  // Test-only escape hatch, same rationale as `store` above.
  threadStore?: ThreadStore;
}

export async function runAfterAgentPipeline(params: RunAfterAgentPipelineParams): Promise<void> {
  const { threadId, messages, provider, model, requestAfterAgentEnabled } = params;

  logger.info('AfterAgent triggered', { threadId });

  // Global kill switch wins even if a request tries to force it on.
  if (!env.afterAgent.enabled) return;
  if (requestAfterAgentEnabled === false) return;

  const turnText = extractLatestTurnText(messages);
  if (!turnText.trim()) return;

  // Where this turn is allowed to file knowledge (#202) — resolved before
  // any LLM call, so a turn we can't place costs nothing. Failing closed
  // matters here: silently falling back to "any domain" is exactly how
  // a workspace's notes leaked into unrelated wikis.
  const scope = resolveWikiWriteScope(
    { threadId, workspaceId: params.workspaceId },
    { workspaceStore: params.store, threadStore: params.threadStore },
  );
  if (scope.kind === 'unresolved') {
    logger.warn('after-agent: could not determine where this thread may write — skipping', {
      threadId,
      workspaceId: params.workspaceId,
    });
    setAfterAgentDone(threadId, 'no-op');
    return;
  }

  // Resolves the real provider/model this pipeline's LLM calls will run
  // against, so the trace below (and the aggregate usage/cost dashboard it
  // feeds) records accurate identity instead of a blank model whenever the
  // triggering thread relies on the app's default provider/model — see
  // stream-handler.ts's equivalent resolve block. Skipped when a test
  // supplies `params.llm` directly (same condition as the `llm` escape
  // hatch below): resolveProviderConfig() throws when no providers are
  // configured, which test env deliberately doesn't set up, matching
  // provider-factory.test.ts's own documented "can't test the live env
  // path" limitation. Production callers never set `params.llm`.
  const { provider: resolvedProvider, model: resolvedModel } = params.llm
    ? { provider: provider ?? env.defaultProvider, model: model ?? '' }
    : resolveTurnModel(provider, model);

  const turnObs = startTurnObservability({
    threadId,
    provider: resolvedProvider,
    model: resolvedModel,
    source: 'after-agent',
    // No systemPrompt: this pipeline runs 4 distinct prompts (summarize/
    // classify/extract/merge) within one trace, none of which is "a system
    // prompt" in the buildSystemPrompt() sense — see TraceRecordSchema's
    // comment. Left unset rather than forcing an ill-fitting single value.
  });
  setAfterAgentState(threadId, { status: 'running' });
  const handler = turnObs.obsHandler;

  let traceError: string | null = null;
  try {
    const llm = params.llm ?? createProvider(provider, model);
    const state = threadState.get(threadId) ?? { rollingSummary: '' };
    // Captured before summarize() folds this turn into the rolling summary —
    // classify must judge novelty against what was known BEFORE this turn,
    // not against a summary that already includes the very facts being
    // classified (which would make every turn look "already covered").
    const priorSummary = state.rollingSummary;

    const { summary } = await invokeStructured(
      llm,
      SummarizeOutputSchema,
      buildSummarizePrompt(priorSummary, turnText),
      handler,
      'after-agent:summarize',
    );
    state.rollingSummary = summary;
    threadState.set(threadId, state);

    const classify = await invokeStructured(
      llm,
      ClassifyOutputSchema,
      buildClassifyPrompt(turnText, priorSummary),
      handler,
      'after-agent:classify',
    );
    if (!classify.shouldWrite) {
      logger.info('AfterAgent no-op', { threadId, reason: classify.reason });
      setAfterAgentDone(threadId, 'no-op');
      return;
    }

    const registry = params.registry ?? (await getWikiRegistry());
    // Only domains this thread may write to are offered — a locked
    // workspace sees exactly one. The unknown-domain check below runs
    // against this filtered list, so an out-of-scope id the model invents
    // no-ops before anything (raw source included) touches that domain.
    const domains = registry.list().filter((d) => checkWikiWrite(scope, d.id).allowed);
    if (domains.length === 0) {
      logger.warn(
        'after-agent: classify said shouldWrite but no wiki domain is writable from this thread',
        {
          threadId,
        },
      );
      setAfterAgentDone(threadId, 'no-op');
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
      setAfterAgentDone(threadId, 'no-op');
      return;
    }

    const wiki = await registry.load(domainEntry.id);
    const prep = await wiki.ingestPrep({
      content: extract.body,
      title: extract.title,
      keywords: extract.tags,
    });

    // Provenance: always save a raw snapshot of the turn, tagged with threadId,
    // so every AfterAgent-written page traces back to the conversation it came from.
    const rawSource = await wiki.saveRawSource({
      content: turnText,
      sourceUrl: `conversation:${threadId}`,
      path: prep.suggestedRawPath,
      sha256: prep.sha256,
    });

    const existingMatch = prep.existingPages[0];
    let writeResult: CreateWikiPageResult | UpdateWikiPageResult;

    if (existingMatch) {
      const existingPage = await wiki.readPage(existingMatch);
      const merged = await invokeStructured(
        llm,
        MergeOutputSchema,
        buildMergePrompt(existingPage.content, extract.body),
        handler,
        'after-agent:merge-page',
      );
      writeResult = await updateWikiPage(
        {
          wikiId: domainEntry.id,
          path: existingMatch,
          content: merged.body,
          tags: extract.tags,
          sources: [rawSource.path],
          summary: extract.summary,
        },
        params.registry,
        scope,
        params.store,
      );
    } else {
      writeResult = await createWikiPage(
        {
          wikiId: domainEntry.id,
          title: extract.title,
          content: extract.body,
          section: extract.type,
          tags: extract.tags,
          sources: [rawSource.path],
          summary: extract.summary,
        },
        params.registry,
        scope,
        params.store,
      );
    }

    if (writeResult.status !== 'written') {
      // None expected in practice given the ingestPrep pre-check above, but
      // handled defensively — same posture as the unknown-domainId branch.
      logger.warn('after-agent: shared write function returned a non-written status', {
        threadId,
        status: writeResult.status,
      });
      setAfterAgentDone(threadId, 'no-op');
      return;
    }

    const commitResult = writeResult.result;

    queueWikiUpdate(threadId, {
      type: 'wiki_updated',
      pageTitle: extract.title,
      pageKind: commitResult.created ? 'created' : 'updated',
      wikiName: domainEntry.id,
      path: commitResult.path,
    });
    setAfterAgentDone(threadId, 'identified');

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

    // Post-write health check — logging only, never flips the write's
    // already-successful 'identified' outcome. Own try/catch, deliberately
    // separate from the pipeline's outer one.
    try {
      const lintReport = await registry.lint(domainEntry.id);
      const errors = lintReport.checks.filter((c) => c.severity === 'error');
      if (errors.length) {
        logger.warn('after-agent: lint found errors after write', {
          threadId,
          wikiId: domainEntry.id,
          errors,
        });
      } else if (lintReport.checks.length) {
        logger.info('after-agent: lint found non-error findings after write', {
          threadId,
          wikiId: domainEntry.id,
          findingCount: lintReport.checks.length,
        });
      }
    } catch (err) {
      logger.warn('after-agent: lint failed after write', {
        threadId,
        err: serializeError(err),
      });
    }
  } catch (err) {
    logger.error('after-agent: pipeline error', { threadId, err: serializeError(err) });
    setAfterAgentDone(threadId, 'error');
    // Never throw — this must not surface back into the afterAgent hook.
    traceError = err instanceof Error ? err.message : String(err);
  } finally {
    await turnObs.end(traceError);
  }
}
