import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';

// Standalone map from threadId → SSE writer function. Lives in its own module
// so tools can import it without pulling in the agent/stream-handler tree, which
// would create: stream-handler → chat-agent → wiki-orient → stream-handler.
// stream-handler writes to this map; tools read from it.

export type SseWriter = (event: ChatSSEEvent) => void;

const _writers = new Map<string, SseWriter>();

// A second map, alongside _writers, from threadId → the AbortController
// driving that thread's in-flight interactive chat turn. Kept separate from
// _writers (rather than folding both into one map value) so every existing
// getActiveSseWriter() caller — tools, task-execution.ts, headless-turn.ts,
// pending-thread-turns.ts — keeps working unchanged; none of them need or
// want the controller. Only the interactive chat/workspace-chat/wiki-chat
// handlers populate this, via setActiveSseWriter's optional third param —
// automated task runs (task-execution.ts) manage their own separate abort
// registry (active-task-abort.ts) and never pass one here, so
// getActiveTurnAbort() correctly returns undefined for a task-owned thread.
const _controllers = new Map<string, AbortController>();

export function setActiveSseWriter(
  threadId: string,
  writer: SseWriter,
  controller?: AbortController,
): void {
  _writers.set(threadId, writer);
  if (controller) _controllers.set(threadId, controller);
}

export function clearActiveSseWriter(threadId: string): void {
  _writers.delete(threadId);
  _controllers.delete(threadId);
}

export function getActiveSseWriter(threadId: string): SseWriter | undefined {
  return _writers.get(threadId);
}

export function getActiveTurnAbort(threadId: string): AbortController | undefined {
  return _controllers.get(threadId);
}

// Shared by every /stop route (chat, workspace-chat, wiki chat) — kept here
// rather than duplicated per route since this module already owns the
// invariant that a lookup and its abort must stay atomic. Returns whether a
// live turn was actually found to stop, so a route can tell an aborted
// turn apart from "nothing running here."
export function stopActiveTurn(threadId: string): boolean {
  const controller = getActiveTurnAbort(threadId);
  if (!controller) return false;
  controller.abort();
  return true;
}

// Shared {status, body} shaping for every /stop route — identical across
// chat/workspace-chat/wiki chat, so each route just calls this rather than
// re-deriving the same 409/202 JSON shape three times.
export function stopTurnResponse(threadId: string): {
  status: number;
  body: { ok: true } | { error: string };
} {
  if (!stopActiveTurn(threadId)) {
    return { status: 409, body: { error: 'No active turn for this thread' } };
  }
  return { status: 202, body: { ok: true } };
}
