import { queueState, patchTask } from '@/hooks/use-tasks';
import { showToast } from '@/lib/toast';
import type { Task } from '@/services/tasks-api';

// Re-pins a ready (not-yet-dequeued) Task's provider from a Green Room drop
// (GLOSSARY.md § Monitoring — Provider Line), mirroring board-move.ts's
// performMove shape: snapshot queueState, apply the new provider straight
// away so the chip shows under its new Provider Line without waiting on the
// round trip, then await the real PATCH and roll back on rejection. There's
// no server-side "is this legal" lookup to consult first (unlike a Kanban
// move) — the gate is just the Pinned Provider PATCH's own existing
// running-task rejection, pre-checked here so a running Task's dot (never
// draggable in the UI anyway) can't even start a doomed round trip.
export async function repinTask(task: Task, provider: string): Promise<boolean> {
  if (task.status !== 'ready') return false;

  const previousQueue = queueState.value;
  queueState.value = {
    ...queueState.value,
    queue: queueState.value.queue.map((entry) =>
      entry.taskId === task.id && entry.task
        ? { ...entry, task: { ...entry.task, provider, model: null } }
        : entry,
    ),
  };

  try {
    await patchTask(task.id, { provider, model: null });
    return true;
  } catch (err) {
    queueState.value = previousQueue;
    showToast('error', err instanceof Error ? err.message : 'Could not switch provider.');
    return false;
  }
}
