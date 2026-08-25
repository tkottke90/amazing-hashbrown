import { createAgent } from 'langchain';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { env } from '../config/env.js';
import { getObservabilityStore } from '../services/observability.js';
import { ObservabilityCallbackHandler } from './observability-handler.js';
import { wikiReadPageTool } from './tools/wiki-read-page.tool.js';
import { wikiSearchTool } from './tools/wiki-search.tool.js';
import type { PlanStep, Workspace } from '../services/workspace-store.js';
import type { FileNode } from '../services/workspace-files.js';

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export function parsePlanSteps(raw: string): PlanStep[] | null {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;

  const steps: PlanStep[] = [];
  for (const entry of parsed) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof (entry as { step?: unknown }).step !== 'string' ||
      !(entry as { step: string }).step.trim() ||
      typeof (entry as { done?: unknown }).done !== 'boolean'
    ) {
      return null;
    }
    steps.push({
      step: (entry as { step: string }).step,
      done: (entry as { done: boolean }).done,
    });
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Prompt building — Path A (workspace_id present)
// ---------------------------------------------------------------------------

const MAX_WIKI_PAGE_CHARS = 1500;
const WIKI_SEARCH_LIMIT = 5;

// Shared by both paths so their output-format contract never drifts apart.
export const PLAN_JSON_INSTRUCTION =
  'Respond with ONLY a JSON array of objects shaped {"step": string, "done": boolean} — ' +
  'no prose, no markdown code fences, no explanation. Every "done" must be false. ' +
  'If you cannot produce a reasonable plan, respond with an empty array: []';

export function buildTaskDescriptionBlock(title: string, description: string | null): string {
  const lines = [`Title: ${title}`];
  if (description && description.trim()) lines.push(`Description: ${description.trim()}`);
  return lines.join('\n');
}

// Keep this in sync with suites/task-plan-generation.yaml's scenario `input`
// fields — the eval suite tests this exact prompt template (Path A only;
// Path B's agentic tool-use isn't a fit for that framework's plain-prompt
// scenario types — see that file's header comment).
export function buildPathAPrompt(input: {
  title: string;
  description: string | null;
  workspace: Workspace | null;
  wikiBlock: string | null;
  fileBlock: string | null;
}): string {
  const sections = [buildTaskDescriptionBlock(input.title, input.description)];

  if (input.workspace) {
    const wsLines = [`Name: ${input.workspace.name}`];
    if (input.workspace.goal) wsLines.push(`Goal: ${input.workspace.goal}`);
    if (input.workspace.description) wsLines.push(`Description: ${input.workspace.description}`);
    sections.push(`## Workspace\n${wsLines.join('\n')}`);
  }

  if (input.wikiBlock) sections.push(`## Relevant wiki context\n${input.wikiBlock}`);
  if (input.fileBlock) sections.push(`## Workspace files (top level)\n${input.fileBlock}`);

  sections.push(
    `Generate a concrete, ordered list of steps to complete this task.\n${PLAN_JSON_INSTRUCTION}`,
  );

  return sections.join('\n\n');
}

// The minimal shape plan-generation needs from a loaded wiki — matches
// @tkottke90/llm-wiki's Wiki instance, kept narrow so this module doesn't
// need to import the library's full type surface just to describe it.
interface WikiLike {
  semanticSearch(
    query: string,
    opts: { limit: number },
  ): Promise<Array<{ path: string; score: number; title: string }>>;
  readPage(
    path: string,
  ): Promise<{ title: string; frontmatter: { type: string; tags: string[] }; content: string }>;
}

// Takes an already-loaded wiki (or null when there's nothing to search) —
// the caller resolves getWikiRegistry()/registry.load(wikiId) and catches
// that failure, so this function stays a pure consumer of its input and is
// trivially testable with a fake { semanticSearch, readPage } object.
export async function buildWikiContextBlock(
  wiki: WikiLike | null,
  query: string,
): Promise<string | null> {
  if (!wiki) return null;

  let results: Array<{ path: string; score: number; title: string }>;
  try {
    results = await wiki.semanticSearch(query, { limit: WIKI_SEARCH_LIMIT });
  } catch {
    return null;
  }
  if (!results || results.length === 0) return null;

  const sections: string[] = [];
  for (const result of results) {
    try {
      const page = await wiki.readPage(result.path);
      const content =
        page.content.length > MAX_WIKI_PAGE_CHARS
          ? `${page.content.slice(0, MAX_WIKI_PAGE_CHARS)}…`
          : page.content;
      sections.push(`### ${page.title}\n${content}`);
    } catch {
      // Skip a page that fails to read — the rest of the block still stands.
    }
  }

  return sections.length > 0 ? sections.join('\n\n') : null;
}

// Depth-1 only — top-level entries' name/type, never `.children`. Caller
// resolves getFileTree() and catches its failure (missing/unreadable root),
// so this function stays a pure, synchronous formatter.
export function buildFileListingBlock(entries: FileNode[] | null): string | null {
  if (!entries || entries.length === 0) return null;
  return entries.map((entry) => `- ${entry.name} (${entry.type})`).join('\n');
}

// ---------------------------------------------------------------------------
// Prompt building — Path B (no workspace_id)
// ---------------------------------------------------------------------------

export const PLAN_GENERATION_SYSTEM_PROMPT =
  'You help draft a first-pass plan for a task. You have wiki_search and wiki_read_page tools ' +
  'available — use them only if you judge they would meaningfully improve the plan; skip them ' +
  `if the task is already self-explanatory. Once you are done researching (if any), respond ` +
  `with your final answer. ${PLAN_JSON_INSTRUCTION}`;

export function buildPathBHumanMessage(title: string, description: string | null): string {
  return (
    `${buildTaskDescriptionBlock(title, description)}\n\n` +
    `Generate a concrete, ordered list of steps to complete this task.\n${PLAN_JSON_INSTRUCTION}`
  );
}

// ---------------------------------------------------------------------------
// Model / agent invocation
// ---------------------------------------------------------------------------

// Single plain completion, no tools, no checkpointer — structural clone of
// threads.handlers.ts's generateTitleHandler. `model` is passed in already
// constructed so this stays unit-testable with a fake BaseChatModel.
export async function runPathA(
  model: BaseChatModel,
  prompt: string,
  provider: string | undefined,
  modelName: string | undefined,
): Promise<string> {
  const obsStore = getObservabilityStore();
  const traceId = obsStore.startTrace({
    provider: provider ?? env.defaultProvider,
    model: modelName ?? '',
    source: 'generate-plan',
    systemPrompt: prompt,
  });
  const obsHandler = new ObservabilityCallbackHandler(
    traceId,
    obsStore,
    env.observability.spanOutputPreviewChars,
  );

  try {
    const response = await model.invoke(prompt, { callbacks: [obsHandler] });
    // A bare model.invoke() (no chain/graph wrapping it) never fires
    // handleChainEnd on its own — same gotcha generateTitleHandler documents.
    await obsHandler.handleChainEnd();
    obsStore.endTrace(traceId, {
      totalTokens: obsHandler.totalInputTokens + obsHandler.totalOutputTokens,
    });
    return typeof response.content === 'string' ? response.content : String(response.content ?? '');
  } catch (err) {
    await obsHandler.handleChainEnd();
    obsStore.endTrace(traceId, {
      totalTokens: obsHandler.totalInputTokens + obsHandler.totalOutputTokens,
    });
    throw err;
  }
}

// A one-off, stateless agent turn — no checkpointer, no middleware, unlike
// the persistent chat agent (chat-agent.ts). `model` is the same
// already-constructed model the route builds for Path A, reused here rather
// than re-derived from provider/modelName a second time.
export async function runPathB(
  model: BaseChatModel,
  humanMessage: string,
  provider: string | undefined,
  modelName: string | undefined,
): Promise<string> {
  const obsStore = getObservabilityStore();
  const traceId = obsStore.startTrace({
    provider: provider ?? env.defaultProvider,
    model: modelName ?? '',
    source: 'generate-plan',
    systemPrompt: PLAN_GENERATION_SYSTEM_PROMPT,
  });
  const obsHandler = new ObservabilityCallbackHandler(
    traceId,
    obsStore,
    env.observability.spanOutputPreviewChars,
  );

  const planAgent = createAgent({
    model,
    tools: [wikiSearchTool, wikiReadPageTool],
    systemPrompt: PLAN_GENERATION_SYSTEM_PROMPT,
  });

  try {
    const result = await planAgent.invoke(
      { messages: [{ role: 'human', content: humanMessage }] },
      { callbacks: [obsHandler] },
    );
    await obsHandler.handleChainEnd();
    obsStore.endTrace(traceId, {
      totalTokens: obsHandler.totalInputTokens + obsHandler.totalOutputTokens,
    });

    const messages = (result as { messages: Array<{ content: unknown }> }).messages;
    const last = messages[messages.length - 1];
    const content = last?.content;
    return typeof content === 'string' ? content : String(content ?? '');
  } catch (err) {
    await obsHandler.handleChainEnd();
    obsStore.endTrace(traceId, {
      totalTokens: obsHandler.totalInputTokens + obsHandler.totalOutputTokens,
    });
    throw err;
  }
}
