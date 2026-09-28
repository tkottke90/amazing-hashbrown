import type { Lane, QueueState, Task } from '@/services/tasks-api';

// Pure helpers behind the board and the mobile list: which cards go in which
// lane and in what order, and what a drop means. Lane membership itself is
// the server's `board.lane`; nothing here re-derives it from status.

export const LANE_ORDER: readonly Lane[] = ['backlog', 'scheduled', 'queue', 'attention', 'done'];

export const LANE_SUBTITLES: Record<Lane, string> = {
  backlog: 'Not queued yet',
  scheduled: 'Joins Queue at its start time',
  queue: 'Runs top to bottom, one at a time',
  attention: 'Answer, unblock or retry',
  done: 'Finished or cancelled',
};

export function laneOf(task: Task): Lane {
  return task.board?.lane ?? 'backlog';
}

const byTime = (pick: (t: Task) => string | null | undefined, direction: 1 | -1) => {
  return (a: Task, b: Task) => {
    const ta = pick(a);
    const tb = pick(b);
    if (!ta && !tb) return 0;
    if (!ta) return 1; // missing times sort last
    if (!tb) return -1;
    return direction * ta.localeCompare(tb);
  };
};

// Groups tasks into lanes, each in the order it's shown:
// - Queue: the running task first, then ready tasks in actual queue order
// - Scheduled: soonest start first
// - Backlog: oldest first (first in, first considered)
// - Needs attention / Done: most recently changed first
export function tasksByLane(taskList: Task[], queue: QueueState): Record<Lane, Task[]> {
  const lanes: Record<Lane, Task[]> = {
    backlog: [],
    scheduled: [],
    queue: [],
    attention: [],
    done: [],
  };
  for (const task of taskList) lanes[laneOf(task)].push(task);

  const queueIndex = new Map(queue.queue.map((entry, i) => [entry.taskId, i]));
  const rank = (t: Task) =>
    t.status === 'running' ? -1 : (queueIndex.get(t.id) ?? Number.MAX_SAFE_INTEGER);
  lanes.queue.sort((a, b) => rank(a) - rank(b));
  lanes.scheduled.sort(byTime((t) => t.schedule?.nextFireAt, 1));
  lanes.backlog.sort(byTime((t) => t.createdAt, 1));
  lanes.attention.sort(byTime((t) => t.updatedAt, -1));
  lanes.done.sort(byTime((t) => t.updatedAt, -1));
  return lanes;
}

// The Queue cards that can be reordered: queued, not running.
export function reorderableQueue(lanes: Record<Lane, Task[]>): Task[] {
  return lanes.queue.filter((t) => t.status === 'ready');
}

export const laneDropId = (lane: Lane) => `lane:${lane}`;

export interface DropTarget {
  to: Lane;
  position?: number;
}

// What dropping `task` on the droppable `overId` means: a move to a lane,
// or a reorder within the Queue (with the index among queued cards).
// Returns null for a drop that changes nothing — back onto its own lane, or
// onto itself.
export function resolveDrop(
  task: Task,
  overId: string,
  lanes: Record<Lane, Task[]>,
): DropTarget | null {
  const from = laneOf(task);
  const reorderable = reorderableQueue(lanes);

  let to: Lane;
  let overTask: Task | undefined;
  if (overId.startsWith('lane:')) {
    to = overId.slice('lane:'.length) as Lane;
  } else {
    if (overId === task.id) return null;
    const lane = LANE_ORDER.find((l) => lanes[l].some((t) => t.id === overId));
    if (!lane) return null;
    to = lane;
    overTask = lanes[lane].find((t) => t.id === overId);
  }

  if (to !== from) return { to };
  if (to !== 'queue' || task.status !== 'ready') return null;

  // Reorder within the Queue: dropped on a queued card takes its slot;
  // dropped on the lane itself (or the running card) goes to the end.
  const index =
    overTask && overTask.status === 'ready'
      ? reorderable.findIndex((t) => t.id === overTask.id)
      : reorderable.length - 1;
  const current = reorderable.findIndex((t) => t.id === task.id);
  return index === current ? null : { to: 'queue', position: index };
}
