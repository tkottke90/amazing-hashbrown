// Standalone map from task_queue entry id -> live abort handle. Lives in its
// own module, mirroring active-sse-writer.ts, so route handlers (tasks
// layer) can reach a running task's AbortController without importing the
// whole task-execution/agent tree.

export type AbortIntent = 'cancel' | 'pause' | 'take-over' | null;

export interface AbortEntry {
  controller: AbortController;
  intent: AbortIntent;
}

const _controllers = new Map<string, AbortEntry>();

export function registerTaskAbort(queueEntryId: string): AbortController {
  const controller = new AbortController();
  _controllers.set(queueEntryId, { controller, intent: null });
  return controller;
}

// Returns whether a live entry was found for this queue entry id (i.e.
// whether there's actually a run in flight to abort) — callers (route
// handlers) use this to decide whether to 409 instead of silently no-oping.
export function setAbortIntent(queueEntryId: string, intent: AbortIntent): boolean {
  const entry = _controllers.get(queueEntryId);
  if (!entry) return false;
  entry.intent = intent;
  return true;
}

export function getTaskAbort(queueEntryId: string): AbortEntry | undefined {
  return _controllers.get(queueEntryId);
}

export function clearTaskAbort(queueEntryId: string): void {
  _controllers.delete(queueEntryId);
}
