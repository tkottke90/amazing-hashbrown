// The Kanban board's lane and move rules — the ONE place they live. The API
// projects `boardFor()` onto every task it returns and executes
// `planMove()`'s steps from POST /tasks/:id/move; the UI only renders what
// it's told (which lane, which lanes a card may be dropped on, and whether a
// drop needs extra input first). Pure: no I/O — callers pre-fetch
// BoardContext. See docs/superpowers/specs/2026-09-28-kanban-board-v2-design.md.

import type { TaskSchedule } from './cron-config.js';
import type {
  DependencyEdgeSummary,
  FailedRunStreak,
  Task,
  TaskQueueEntry,
} from './workspace-store.js';

export type Lane = 'backlog' | 'scheduled' | 'queue' | 'attention' | 'done';

export const LANES: readonly Lane[] = ['backlog', 'scheduled', 'queue', 'attention', 'done'];

// What the UI must collect before it can send the move: a start time
// (picker), the answer to the agent's question, or confirmation that a task
// assigned to the user should be handed to the agent.
export type MoveNeeds = 'none' | 'start_time' | 'reply' | 'reassign';

export interface Move {
  to: Lane;
  needs: MoveNeeds;
}

export interface TaskRef {
  id: string;
  title: string;
  trackerId: string | null;
}

export interface ReplyChoice {
  label: string;
  value: string;
}

// Why a card sits where it does, with exactly the facts its card needs.
export type BoardReason =
  | {
      kind: 'waiting_on_user';
      question: string | null;
      choices: ReplyChoice[];
      allowFreeText: boolean;
    }
  | { kind: 'failed'; summary: string | null; attempts: number }
  | { kind: 'paused' }
  | { kind: 'dependency_failed'; dependency: TaskRef | null }
  | { kind: 'schedule_paused'; failures: number }
  | { kind: 'waiting_on_dependency'; dependencies: TaskRef[] }
  | { kind: 'assigned_to_user' };

export interface Board {
  lane: Lane;
  moves: Move[];
  reason?: BoardReason;
}

// The agent's still-unanswered question for a waiting task, normalized from
// its hitl_prompt message.
export interface PendingPrompt {
  threadId: string;
  promptId: string;
  question: string | null;
  choices: ReplyChoice[];
  allowFreeText: boolean;
}

// Everything the rules need beyond the task row, pre-fetched in batch.
export interface BoardContext {
  queueEntry: TaskQueueEntry | null; // the task's active (pending/running/paused) row
  dependencies: DependencyEdgeSummary[];
  schedule: TaskSchedule | null;
  pendingPrompt: PendingPrompt | null;
  failedStreak: FailedRunStreak | null;
}

// One concrete operation of a move, executed in order by the move handler.
// Steps that need request input (start time, reply, queue index) read it
// from the move request, which the handler has already validated against
// the plan's `needs`.
export type MoveStep =
  | { kind: 'enqueue' }
  | { kind: 'dequeue' } // pending queue row → deleted, task → pending
  | { kind: 'detach_paused' } // a paused run is closed out as cancelled
  | { kind: 'pause' }
  | { kind: 'resume' } // a human-paused task → ready (existing resume path)
  | { kind: 'patch_status'; status: 'pending' | 'done' }
  | { kind: 'disable_trigger' }
  | { kind: 'enable_trigger' }
  | { kind: 'clear_trigger' } // → manual trigger; the schedule is consumed/dropped
  | { kind: 'save_cron_once' }
  | { kind: 'reassign_to_agent' }
  | { kind: 'answer_prompt'; threadId: string; promptId: string }
  | { kind: 'reorder' }
  | { kind: 'release_dependents' };

export type MovePlan = { ok: true; needs: MoveNeeds; steps: MoveStep[] } | Rejection;

export interface Rejection {
  ok: false;
  reason: string;
}

// Where a task is coming FROM, finer-grained than its lane: the move table's
// rows (spec §1.3).
type Source =
  | 'pending_agent'
  | 'pending_user'
  | 'pending_waiting_dependency'
  | 'scheduled'
  | 'ready'
  | 'running'
  | 'waiting_on_user'
  | 'blocked_paused'
  | 'blocked_dependency_failed'
  | 'failed'
  | 'schedule_paused'
  | 'done';

const FINISHED_SCHEDULE = new Set(['exhausted', 'expired', 'fired']);

function isCron(task: Task): boolean {
  return task.triggerType === 'cron_once' || task.triggerType === 'cron_repeat';
}

function toRef(target: { id: string; title: string; trackerId: string | null }): TaskRef {
  return { id: target.id, title: target.title, trackerId: target.trackerId };
}

function unmetDependencies(ctx: BoardContext): TaskRef[] {
  return ctx.dependencies.filter((edge) => !edge.satisfied).map((edge) => toRef(edge.target));
}

function isSchedulePaused(task: Task, ctx: BoardContext): boolean {
  return task.status === 'pending' && isCron(task) && ctx.schedule?.inactiveReason === 'failures';
}

function isScheduleFinished(task: Task, ctx: BoardContext): boolean {
  return (
    task.status === 'pending' &&
    isCron(task) &&
    FINISHED_SCHEDULE.has(ctx.schedule?.inactiveReason ?? '')
  );
}

function sourceOf(task: Task, ctx: BoardContext): Source {
  switch (task.status) {
    case 'waiting_on_user':
      return 'waiting_on_user';
    case 'failed':
      return 'failed';
    case 'blocked':
      return task.blockedReason === 'dependency_failed'
        ? 'blocked_dependency_failed'
        : 'blocked_paused';
    case 'ready':
      return 'ready';
    case 'running':
      return 'running';
    case 'scheduled':
      return 'scheduled';
    case 'done':
    case 'cancelled':
      return 'done';
    case 'pending':
      if (isSchedulePaused(task, ctx)) return 'schedule_paused';
      if (isScheduleFinished(task, ctx)) return 'done';
      if (task.assignedTo === 'user') return 'pending_user';
      if (unmetDependencies(ctx).length > 0) return 'pending_waiting_dependency';
      return 'pending_agent';
  }
}

const LANE_OF: Record<Source, Lane> = {
  waiting_on_user: 'attention',
  failed: 'attention',
  blocked_dependency_failed: 'attention',
  blocked_paused: 'attention',
  schedule_paused: 'attention',
  ready: 'queue',
  running: 'queue',
  scheduled: 'scheduled',
  done: 'done',
  pending_user: 'backlog',
  pending_waiting_dependency: 'backlog',
  pending_agent: 'backlog',
};

function reasonFor(task: Task, ctx: BoardContext, source: Source): BoardReason | undefined {
  switch (source) {
    case 'waiting_on_user':
      return {
        kind: 'waiting_on_user',
        question: ctx.pendingPrompt?.question ?? null,
        choices: ctx.pendingPrompt?.choices ?? [],
        allowFreeText: ctx.pendingPrompt?.allowFreeText ?? true,
      };
    case 'failed':
      return {
        kind: 'failed',
        summary: ctx.failedStreak?.lastSummary ?? null,
        attempts: ctx.failedStreak?.attempts ?? 1,
      };
    case 'blocked_paused':
      return { kind: 'paused' };
    case 'blocked_dependency_failed': {
      const broken = ctx.dependencies.find(
        (edge) =>
          edge.dependency.requireSuccess &&
          (edge.target.status === 'failed' || edge.target.status === 'cancelled'),
      );
      return { kind: 'dependency_failed', dependency: broken ? toRef(broken.target) : null };
    }
    case 'schedule_paused':
      return { kind: 'schedule_paused', failures: scheduleFailures(task) };
    case 'pending_user':
      return { kind: 'assigned_to_user' };
    case 'pending_waiting_dependency':
      return { kind: 'waiting_on_dependency', dependencies: unmetDependencies(ctx) };
    default:
      return undefined;
  }
}

function scheduleFailures(task: Task): number {
  const config = task.triggerConfig as { consecutiveFailures?: unknown } | null;
  return typeof config?.consecutiveFailures === 'number' ? config.consecutiveFailures : 0;
}

function reject(reason: string): Rejection {
  return { ok: false, reason };
}

function plan(steps: MoveStep[], needs: MoveNeeds = 'none'): MovePlan {
  return { ok: true, needs, steps };
}

const MARK_DONE: MoveStep[] = [
  { kind: 'patch_status', status: 'done' },
  { kind: 'release_dependents' },
];

// Scheduling a task gives it a one-off start time. Tasks whose trigger is
// something a one-off time would overwrite must be edited in the task
// details instead, so a drag never silently destroys a webhook or a
// repeating schedule.
function scheduleOnce(task: Task, prefix: MoveStep[] = []): MovePlan {
  if (task.triggerType === 'webhook') {
    return reject('Webhook-triggered tasks are scheduled from the task details.');
  }
  if (task.triggerType === 'cron_repeat') {
    return reject('Change a repeating schedule from the task details.');
  }
  return plan([...prefix, { kind: 'save_cron_once' }], 'start_time');
}

const ALREADY_HERE = 'Already in this lane.';
const ATTENTION_IS_AUTOMATIC =
  'Tasks land in Needs attention on their own; only a running task can be paused into it.';

// The move table (spec §1.3): which steps turn a task from `source` into a
// task in lane `to`, or why it can't go there.
function planFrom(task: Task, ctx: BoardContext, source: Source, to: Lane): MovePlan {
  if (to === 'attention' && source !== 'running') {
    return reject(LANE_OF[source] === 'attention' ? ALREADY_HERE : ATTENTION_IS_AUTOMATIC);
  }

  switch (source) {
    case 'pending_agent':
    case 'pending_user':
      if (to === 'scheduled') return scheduleOnce(task);
      if (to === 'queue') {
        return source === 'pending_user'
          ? plan([{ kind: 'reassign_to_agent' }, { kind: 'enqueue' }], 'reassign')
          : plan([{ kind: 'enqueue' }]);
      }
      if (to === 'done') return plan(MARK_DONE);
      return reject(ALREADY_HERE);

    case 'pending_waiting_dependency':
      if (to === 'done') return plan(MARK_DONE);
      if (to === 'backlog') return reject(ALREADY_HERE);
      return reject('This task is waiting on its dependencies and moves to Queue on its own.');

    case 'scheduled':
      if (to === 'backlog') return plan([{ kind: 'disable_trigger' }]);
      if (to === 'queue') {
        // Run now: a one-off schedule is consumed by the early run; a
        // repeating one runs once and returns to Scheduled afterwards.
        return task.triggerType === 'cron_once'
          ? plan([{ kind: 'clear_trigger' }, { kind: 'enqueue' }])
          : plan([{ kind: 'enqueue' }]);
      }
      if (to === 'scheduled') return scheduleOnce(task); // reschedule
      return plan([{ kind: 'disable_trigger' }, ...MARK_DONE]);

    case 'ready': {
      const takeOut: MoveStep =
        ctx.queueEntry?.status === 'pending'
          ? { kind: 'dequeue' }
          : { kind: 'patch_status', status: 'pending' };
      if (to === 'backlog') return plan([takeOut]);
      if (to === 'scheduled') return scheduleOnce(task, [takeOut]);
      if (to === 'queue') {
        return ctx.queueEntry?.status === 'pending'
          ? plan([{ kind: 'reorder' }])
          : reject('Only queued tasks can be reordered.');
      }
      return plan([takeOut, ...MARK_DONE]);
    }

    case 'running':
      if (to === 'attention') return plan([{ kind: 'pause' }]);
      if (to === 'queue') return reject(ALREADY_HERE);
      return reject('A running task can only be paused here; cancel it from the task details.');

    case 'waiting_on_user':
      if (to === 'queue') {
        const prompt = ctx.pendingPrompt;
        return prompt
          ? plan(
              [{ kind: 'answer_prompt', threadId: prompt.threadId, promptId: prompt.promptId }],
              'reply',
            )
          : reject("Answer the agent's question from the workspace chat.");
      }
      return reject("Answer the agent's question first.");

    case 'blocked_paused':
      if (to === 'queue') return plan([{ kind: 'resume' }]);
      if (to === 'backlog') {
        return plan([{ kind: 'detach_paused' }, { kind: 'patch_status', status: 'pending' }]);
      }
      if (to === 'scheduled') {
        return scheduleOnce(task, [
          { kind: 'detach_paused' },
          { kind: 'patch_status', status: 'pending' },
        ]);
      }
      return plan([{ kind: 'detach_paused' }, ...MARK_DONE]);

    case 'blocked_dependency_failed':
      if (to === 'backlog') return plan([{ kind: 'patch_status', status: 'pending' }]);
      if (to === 'done') return plan(MARK_DONE);
      return reject(
        'A dependency of this task failed. Take it over or remove the dependency from the task details.',
      );

    case 'failed':
      if (to === 'backlog') return plan([{ kind: 'patch_status', status: 'pending' }]);
      if (to === 'scheduled') return scheduleOnce(task);
      if (to === 'queue') return plan([{ kind: 'enqueue' }]); // retry
      return plan(MARK_DONE);

    case 'schedule_paused':
      // The repeating schedule stopped after too many failed runs.
      if (to === 'scheduled') return plan([{ kind: 'enable_trigger' }]); // resume the schedule
      if (to === 'queue') return plan([{ kind: 'enqueue' }]); // try it once by hand
      if (to === 'backlog') return plan([{ kind: 'clear_trigger' }]); // stop scheduling it
      return plan(MARK_DONE);

    case 'done': {
      // A cron task in Done whose schedule has finished would land straight
      // back in Done as 'pending', so reopening it drops the spent schedule.
      const reopen: MoveStep[] = isCron(task)
        ? [{ kind: 'clear_trigger' }, { kind: 'patch_status', status: 'pending' }]
        : [{ kind: 'patch_status', status: 'pending' }];
      if (to === 'backlog') return plan(reopen);
      if (to === 'scheduled') {
        return task.triggerType === 'cron_repeat'
          ? reject('Change a repeating schedule from the task details.')
          : scheduleOnce(task);
      }
      if (to === 'queue') return plan([{ kind: 'enqueue' }]); // rerun
      return reject(ALREADY_HERE);
    }
  }
}

export function planMove(task: Task, ctx: BoardContext, to: Lane): MovePlan {
  return planFrom(task, ctx, sourceOf(task, ctx), to);
}

export function boardFor(task: Task, ctx: BoardContext): Board {
  const source = sourceOf(task, ctx);
  const moves: Move[] = [];
  for (const to of LANES) {
    const result = planFrom(task, ctx, source, to);
    if (result.ok) moves.push({ to, needs: result.needs });
  }
  const reason = reasonFor(task, ctx, source);
  return reason ? { lane: LANE_OF[source], moves, reason } : { lane: LANE_OF[source], moves };
}
