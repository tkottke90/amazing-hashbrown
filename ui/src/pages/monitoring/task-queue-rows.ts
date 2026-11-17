import type { QueueState, Task, TaskQueueEntry } from '@/services/tasks-api';
import type { Workspace } from '@/services/workspaces-api';

// The Task Queue Monitor's own composition over already-live data (no new
// backend endpoint — see docs/superpowers/specs/2026-11-16-monitoring-task-queue-provider-activity-design.md).
// `queueState` already carries everything this needs; `listQueue()`'s SQL
// (and so QueueState.queue) includes 'paused' rows too, which correspond to
// a Task's 'blocked' status — Attention-lane, deliberately excluded here
// (see GLOSSARY.md § Task Queue Monitor).
export interface TaskQueueRow {
  task: Task;
  workspaceName: string;
  status: 'ready' | 'running';
  elapsedMs: number;
  queueEntryId: string;
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function elapsedSince(entry: TaskQueueEntry, now: number): number {
  const since = entry.startedAt ?? entry.enqueuedAt;
  return now - new Date(since).getTime();
}

export function buildTaskQueueRows(
  queue: QueueState,
  workspaces: Workspace[],
  now: number = Date.now(),
): TaskQueueRow[] {
  const entries: (TaskQueueEntry & { task: Task | null })[] = [...queue.queue, ...queue.running];

  const rows: TaskQueueRow[] = [];
  for (const entry of entries) {
    const task = entry.task;
    if (!task || (task.status !== 'ready' && task.status !== 'running')) continue;

    const workspaceName = task.workspaceId
      ? (workspaces.find((w) => w.id === task.workspaceId)?.name ?? 'Inbox')
      : 'Inbox';

    rows.push({
      task,
      workspaceName,
      status: task.status,
      elapsedMs: elapsedSince(entry, now),
      queueEntryId: entry.id,
    });
  }
  return rows;
}
