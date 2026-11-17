import type { ProviderActivityCaller, ProviderActivitySnapshot } from '@tkottke90/llm-common-types/chat';
import type { QueueState, Task } from '@/services/tasks-api';

// One entry on a Provider's own Provider Line inside the Green Room
// (GLOSSARY.md § Monitoring) — pooling, deliberately, two different reasons
// a request isn't seated yet (ADR-0068): a live request genuinely blocked on
// ProviderQueue's concurrency gate ('live', already running — its Task, if
// any, is locked), or a ready Task pinned to this provider that the
// scheduler hasn't dequeued yet ('ready' — the only kind a drag can re-pin).
export type GreenRoomEntry =
  | { source: 'live'; key: string; label: string; caller: ProviderActivityCaller }
  | { source: 'ready'; key: string; label: string; task: Task };

// Joins ProviderQueue's real wait state with the Task Queue's own ready
// (not-yet-dequeued) tasks, grouped by resolved Pinned Provider — the one
// case ProviderQueue itself never sees (see docs/adr/0068). `queue.queue`
// already carries every ready task app-wide, the same data the Task Queue
// Monitor's table composes over.
export function buildGreenRoomLanes(
  snapshots: ProviderActivitySnapshot[],
  queue: QueueState,
  defaultProvider: string,
): Map<string, GreenRoomEntry[]> {
  const lanes = new Map<string, GreenRoomEntry[]>();
  for (const snap of snapshots) {
    lanes.set(
      snap.provider,
      snap.waiting.map((caller) => ({
        source: 'live',
        key: caller.threadId,
        label: caller.label,
        caller,
      })),
    );
  }
  for (const entry of queue.queue) {
    const task = entry.task;
    if (!task || task.status !== 'ready') continue;
    const providerName = task.provider || defaultProvider;
    if (!providerName) continue;
    const lane = lanes.get(providerName) ?? [];
    lane.push({ source: 'ready', key: task.id, label: `Task: ${task.title}`, task });
    lanes.set(providerName, lane);
  }
  return lanes;
}
