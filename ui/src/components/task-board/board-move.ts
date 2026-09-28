import { signal } from '@preact/signals';
import { moveTask, queueState, replaceTask } from '@/hooks/use-tasks';
import { showToast } from '@/lib/toast';
import type { Lane, Move, MoveRequest, Task } from '@/services/tasks-api';

// The one path every Kanban move takes — a drag on the desktop board, a
// card's action button on mobile, or a button in the task drawer. The
// server decides what a move means (see the API's board-rules.ts); this
// module only (1) asks for whatever input the move `needs` first, (2)
// shows the move immediately, and (3) rolls back with the server's reason
// if it's rejected.

export const LANE_LABELS: Record<Lane, string> = {
  backlog: 'Backlog',
  scheduled: 'Scheduled',
  queue: 'Queue',
  attention: 'Needs attention',
  done: 'Done',
};

// A move waiting on input from a dialog (see move-prompts.tsx), mounted
// once at the app root like the toast container.
export type MovePrompt =
  | { kind: 'start_time'; task: Task; to: Lane }
  | { kind: 'reassign'; task: Task; to: Lane; position?: number };

export const movePrompt = signal<MovePrompt | null>(null);

export function findMove(task: Task, to: Lane): Move | undefined {
  return task.board?.moves.find((m) => m.to === to);
}

// Mirrors the API's reorderQueue() on the local queue snapshot so a card
// dropped mid-Queue lands there at once: the task's pending entry moves to
// `position` among the pending entries of its own workspace, and those
// entries keep the slots they already occupied.
function reorderQueueSnapshot(taskId: string, position: number): void {
  const queue = queueState.value.queue;
  const moving = queue.find((e) => e.taskId === taskId);
  if (!moving || moving.status !== 'pending') return;
  const scope = moving.task?.workspaceId ?? null;
  const slots = queue
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.status === 'pending' && (e.task?.workspaceId ?? null) === scope);
  const ordered = slots.map(({ e }) => e).filter((e) => e.taskId !== taskId);
  ordered.splice(Math.max(0, Math.min(position, ordered.length)), 0, moving);
  const next = [...queue];
  slots.forEach(({ i }, k) => {
    next[i] = ordered[k]!;
  });
  queueState.value = { ...queueState.value, queue: next };
}

// Sends a move the user has already supplied any needed input for. Shows the
// card in its target lane straight away; on rejection puts it back and
// surfaces the server's reason. Resolves to whether the move landed.
export async function performMove(
  task: Task,
  request: MoveRequest,
  opts: { successMessage?: string } = {},
): Promise<boolean> {
  const previousQueue = queueState.value;
  if (task.board) {
    replaceTask({ ...task, board: { ...task.board, lane: request.to, moves: [] } });
  }
  if (request.position !== undefined) reorderQueueSnapshot(task.id, request.position);

  try {
    await moveTask(task.id, request);
    if (opts.successMessage) showToast('success', opts.successMessage);
    return true;
  } catch (err) {
    replaceTask(task);
    queueState.value = previousQueue;
    showToast('error', err instanceof Error ? err.message : 'Could not move the task.');
    return false;
  }
}

export type MoveOutcome = 'moved' | 'prompted' | 'reply' | 'not_allowed';

// Starts a move to `to`: sends it straight away when it needs nothing,
// otherwise opens the prompt for what it needs. `onReply` is how the caller
// collects an answer for the agent (the desktop drawer's reply box, or the
// mobile reply sheet) — the reply itself is sent with performMove().
export function requestMove(
  task: Task,
  to: Lane,
  opts: { position?: number; onReply?: (task: Task) => void; successMessage?: string } = {},
): MoveOutcome {
  const move = findMove(task, to);
  if (!move) return 'not_allowed';

  switch (move.needs) {
    case 'none':
      void performMove(
        task,
        opts.position === undefined ? { to } : { to, position: opts.position },
        { successMessage: opts.successMessage },
      );
      return 'moved';
    case 'start_time':
      movePrompt.value = { kind: 'start_time', task, to };
      return 'prompted';
    case 'reassign':
      movePrompt.value = { kind: 'reassign', task, to, position: opts.position };
      return 'prompted';
    case 'reply':
      opts.onReply?.(task);
      return 'reply';
  }
}
