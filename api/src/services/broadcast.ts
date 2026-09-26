import type { AppBroadcastEvent } from '@tkottke90/llm-common-types/chat';

// Fan-out registry for the standing app-level SSE channel (GET /api/v1/events)
// — deliberately its own standalone module (no dependency on
// stream-handler.ts/active-sse-writer.ts) so it can be imported directly by
// both task-scheduler.ts and task-execution.ts without the circular-import
// concern that made the old registerQueueBroadcast() callback-injection
// pattern necessary. Unlike active-sse-writer.ts's per-thread map (one
// writer per thread id, doubling as a concurrency mutex), this is a plain
// Set — every connected client (potentially several tabs) gets every event.
// See docs/superpowers/specs/2026-09-23-live-event-broadcast-design.md.

type BroadcastWriter = (event: AppBroadcastEvent) => void;

const _clients = new Set<BroadcastWriter>();

export function registerBroadcastClient(writer: BroadcastWriter): void {
  _clients.add(writer);
}

export function unregisterBroadcastClient(writer: BroadcastWriter): void {
  _clients.delete(writer);
}

export function broadcast(event: AppBroadcastEvent): void {
  for (const writer of _clients) writer(event);
}

// Test-only seam — the registry is otherwise opaque by design (no way to
// inspect who's connected). Used to assert a disconnected client's writer
// was actually removed, which register/unregister alone can't prove from
// outside this module. Mirrors _resetThreadInstancesForTests()'s role in
// use-thread.ts.
export function _clientCount(): number {
  return _clients.size;
}
