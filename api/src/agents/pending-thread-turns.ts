import { getActiveSseWriter } from './active-sse-writer.js';

// A spawn_sub_agent completion notification (see sub-agent-notification.ts)
// can't simply drop what it wants to say if the parent thread's per-thread
// mutex (active-sse-writer.ts) is already held by a live turn — unlike an
// interactive request that can fail and let the user resend, there's no one
// to retry a system-generated delivery. Queue it instead, FIFO per thread,
// and deliver it the moment the mutex frees. See
// docs/superpowers/specs/2026-09-09-sub-agent-tooling-design.md §5.
//
// This module deliberately stays as import-light as active-sse-writer.ts
// itself (see that file's own header comment on why) — every existing
// clearActiveSseWriter(threadId) call site (task-execution.ts,
// workspace-chat-stream-handler.ts) must call drainPendingTurns(threadId)
// right after it, or a notification queued behind a live turn on that same
// thread would never be delivered. active-sse-writer.ts is not modified to
// call this itself, to avoid pulling the agent/stream-handler tree into it.
type PendingTurn = () => Promise<void>;

const _queues = new Map<string, PendingTurn[]>();

// Runs `run` immediately if threadId's mutex is currently free, otherwise
// appends it to that thread's queue for drainPendingTurns() to pick up
// later. Fire-and-forget either way — the caller (a completion notification)
// never awaits delivery.
export function enqueuePendingTurn(threadId: string, run: PendingTurn): void {
  if (!getActiveSseWriter(threadId)) {
    void run();
    return;
  }
  const queue = _queues.get(threadId);
  if (queue) {
    queue.push(run);
  } else {
    _queues.set(threadId, [run]);
  }
}

// Pops and runs the next queued turn for threadId, if any. Safe to call
// unconditionally (a no-op when nothing is queued) — every
// clearActiveSseWriter(threadId) call site calls this right after.
export function drainPendingTurns(threadId: string): void {
  const queue = _queues.get(threadId);
  if (!queue || queue.length === 0) return;
  const next = queue.shift();
  if (queue.length === 0) _queues.delete(threadId);
  if (next) void next();
}
