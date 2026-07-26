import type { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type {
  ThreadDetail,
  ThreadMessageRecord,
  ThreadStore,
  ThreadSummary,
} from '../../services/thread-store.js';
import { forkThreadCheckpoints } from '../../agents/thread-fork.js';
import { ObservabilityCallbackHandler } from '../../agents/observability-handler.js';
import { getObservabilityStore } from '../../services/observability.js';
import { getAfterAgentState, type AfterAgentState } from '../../agents/after-agent.js';
import { env } from '../../config/env.js';

// The client-facing shape (ui/src/types/thread-message.ts's ThreadMessage
// union): id/kind/seq/status live as their own DB columns in
// ThreadMessageRecord, while every other field (content, toolName, question,
// ...) lives inside `payload`, stored without id/seq/status to avoid
// duplicating them. This flattens a record back into the single object the
// client expects — payload spread first so id/kind/seq/status (the
// authoritative column values) always win over anything accidentally
// duplicated inside payload itself.
function toClientMessage(record: ThreadMessageRecord): Record<string, unknown> {
  const payload =
    record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)
      : {};
  return {
    ...payload,
    id: record.id,
    kind: record.kind,
    seq: record.seq,
    ...(record.status !== null ? { status: record.status } : {}),
  };
}

export interface ClientThreadDetail extends Omit<ThreadDetail, 'messages'> {
  messages: Record<string, unknown>[];
}

// Plain, Express-agnostic handler functions — no req/res anywhere. The
// (untested, thin) threads.route.ts maps HandlerResult failures to HTTP
// status codes; Mocha tests call these directly with plain arguments. See
// docs/Design/2026-07-18-persistent-conversation-memory-design.md.

export interface HandlerFailure {
  ok: false;
  status: 404 | 400 | 500;
  error: string;
}

export type HandlerResult<T> = { ok: true; data: T } | HandlerFailure;

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function notFound(error: string): HandlerFailure {
  return { ok: false, status: 404, error };
}

function serverError(error: string): HandlerFailure {
  return { ok: false, status: 500, error };
}

function invalid(error: string): HandlerFailure {
  return { ok: false, status: 400, error };
}

// The list response is enriched with live, non-persisted AfterAgent status —
// ThreadSummary (thread-store.ts) stays a pure DB-row shape; this is an
// API-response-only type, same layering toClientMessage() already uses.
export interface ThreadSummaryResponse extends ThreadSummary {
  afterAgentState: AfterAgentState;
  links: { self: string; afterAgentStatus: string };
}

function withAfterAgentInfo(thread: ThreadSummary): ThreadSummaryResponse {
  return {
    ...thread,
    afterAgentState: getAfterAgentState(thread.id),
    links: {
      self: `/api/v1/threads/${thread.id}`,
      afterAgentStatus: `/api/v1/threads/${thread.id}/after-agent-status`,
    },
  };
}

export function listThreadsHandler(store: ThreadStore): ThreadSummaryResponse[] {
  return store.listThreads().map(withAfterAgentInfo);
}

export function getAfterAgentStatusHandler(
  store: ThreadStore,
  id: string,
): HandlerResult<AfterAgentState> {
  if (!store.getThreadMeta(id)) return notFound(`Thread "${id}" not found`);
  return ok(getAfterAgentState(id));
}

export function getThreadHandler(
  store: ThreadStore,
  id: string,
  opts: { showErrors?: boolean } = {},
): HandlerResult<ClientThreadDetail> {
  const detail = store.getThread(id, opts);
  if (!detail) return notFound(`Thread "${id}" not found`);
  return ok({ ...detail, messages: detail.messages.map(toClientMessage) });
}

export function renameThreadHandler(
  store: ThreadStore,
  id: string,
  title: string,
): HandlerResult<ThreadSummary> {
  if (!title.trim()) return invalid('title must not be empty');
  const renamed = store.renameThread(id, title.trim());
  if (!renamed) return notFound(`Thread "${id}" not found`);
  return ok(renamed);
}

export async function deleteThreadHandler(
  store: ThreadStore,
  checkpointer: SqliteSaver,
  id: string,
): Promise<HandlerResult<void>> {
  const deleted = store.deleteThread(id);
  if (!deleted) return notFound(`Thread "${id}" not found`);
  await checkpointer.deleteThread(id);
  return ok(undefined);
}

export async function forkThreadHandler(
  store: ThreadStore,
  checkpointer: SqliteSaver,
  id: string,
  atSeq: number,
): Promise<HandlerResult<ClientThreadDetail>> {
  if (!Number.isInteger(atSeq) || atSeq < 1) {
    return invalid('atSeq must be a positive integer');
  }

  const source = store.getThreadMeta(id);
  if (!source) return notFound(`Thread "${id}" not found`);

  const checkpointId = store.resolveForkCheckpointId(id, atSeq);
  if (!checkpointId) {
    return invalid(
      `atSeq ${atSeq} does not resolve to a completed turn on thread "${id}" — cannot fork mid-stream or before any turn has completed`,
    );
  }

  const newThreadId = crypto.randomUUID();
  await forkThreadCheckpoints(checkpointer, id, checkpointId, newThreadId);
  store.createForkedThread(newThreadId, `${source.title} (fork)`, id, atSeq);
  store.copyMessagesToNewThread(id, newThreadId, atSeq);

  const forked = store.getThread(newThreadId);
  if (!forked) {
    // Unreachable in practice — createForkedThread just inserted this row —
    // but keeps the return type honest without a non-null assertion.
    return notFound(`Forked thread "${newThreadId}" not found immediately after creation`);
  }
  return ok({ ...forked, messages: forked.messages.map(toClientMessage) });
}

// Keep this in sync with suites/thread-titles.yaml's scenario `input`
// fields — the eval suite tests this exact prompt template.
const TITLE_PROMPT_PREFIX =
  'Summarize the following conversation as a short, specific title (no more than 6 words). Do not use quotation marks or end with punctuation. Respond with only the title, nothing else.\n\nConversation:\n';

const MAX_TITLE_MESSAGES = 20;
const MAX_TRANSCRIPT_CHARS = 4000;

// A single plain (non-streaming, non-agentic) completion over the thread's
// user/assistant content — no tools, no checkpointer. `model` is passed in
// already constructed (createProvider(provider, modelName)) so this stays
// unit-testable with a fake BaseChatModel, matching this codebase's rule to
// always mock external services in developer tests.
export async function generateTitleHandler(
  store: ThreadStore,
  model: BaseChatModel,
  threadId: string,
  provider: string | undefined,
  modelName: string | undefined,
): Promise<HandlerResult<ThreadSummary>> {
  const detail = store.getThread(threadId, { showErrors: true });
  if (!detail) return notFound(`Thread "${threadId}" not found`);

  const conversational = detail.messages.filter((m) => m.kind === 'user' || m.kind === 'assistant');
  if (conversational.length === 0) {
    return invalid(`Thread "${threadId}" has no messages to summarize`);
  }

  const transcript = conversational
    .slice(-MAX_TITLE_MESSAGES)
    .map((m) => {
      const payload = (m.payload ?? {}) as { content?: unknown };
      const speaker = m.kind === 'user' ? 'User' : 'Assistant';
      return `${speaker}: ${typeof payload.content === 'string' ? payload.content : ''}`;
    })
    .join('\n');
  const truncated =
    transcript.length > MAX_TRANSCRIPT_CHARS ? transcript.slice(-MAX_TRANSCRIPT_CHARS) : transcript;

  const prompt = `${TITLE_PROMPT_PREFIX}${truncated}`;

  const obsStore = getObservabilityStore();
  const traceId = obsStore.startTrace({
    threadId,
    provider: provider ?? env.defaultProvider,
    model: modelName ?? '',
    source: 'generate-title',
    // No separate system message for this source — `prompt` above is the
    // entire input passed to model.invoke(). Stored as systemPrompt for
    // consistency with 'chat' traces even though it's not literally a
    // system message — report/UI code should treat this source's value as
    // "the effective prompt," not "the system message."
    systemPrompt: prompt,
  });
  const obsHandler = new ObservabilityCallbackHandler(
    traceId,
    obsStore,
    env.observability.spanOutputPreviewChars,
  );

  let responseContent: unknown;
  try {
    const response = await model.invoke(prompt, { callbacks: [obsHandler] });
    responseContent = response.content;
  } catch (err) {
    // A bare model.invoke() (no chain/graph wrapping it) never fires
    // handleChainEnd on its own — confirmed empirically, see the design
    // doc's "ObservabilityCallbackHandler integration" note — so the span
    // buffered by handleLLMStart/End would otherwise never be saved.
    await obsHandler.handleChainEnd();
    obsStore.endTrace(traceId, {
      totalTokens: obsHandler.totalInputTokens + obsHandler.totalOutputTokens,
    });
    return serverError(
      `Title generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  await obsHandler.handleChainEnd();
  obsStore.endTrace(traceId, {
    totalTokens: obsHandler.totalInputTokens + obsHandler.totalOutputTokens,
  });

  const rawTitle =
    typeof responseContent === 'string' ? responseContent : String(responseContent ?? '');
  const title = rawTitle
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
  if (!title) return serverError('Title generation produced an empty result');

  // Same operation a rename performs (title + bumps updated_at) — reused
  // rather than duplicated, per the design doc's "generate-title also
  // bumps updated_at" decision.
  const updated = store.renameThread(threadId, title);
  if (!updated) return notFound(`Thread "${threadId}" not found`);
  return ok(updated);
}
