import type { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import type {
  ThreadDetail,
  ThreadMessageRecord,
  ThreadStore,
  ThreadSummary,
} from '../../services/thread-store.js';
import { forkThreadCheckpoints } from '../../agents/thread-fork.js';

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
  status: 404 | 400;
  error: string;
}

export type HandlerResult<T> = { ok: true; data: T } | HandlerFailure;

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function notFound(error: string): HandlerFailure {
  return { ok: false, status: 404, error };
}

function invalid(error: string): HandlerFailure {
  return { ok: false, status: 400, error };
}

export function listThreadsHandler(store: ThreadStore): ThreadSummary[] {
  return store.listThreads();
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
