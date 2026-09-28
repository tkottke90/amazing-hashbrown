// The Kanban board's server side: attaches the computed `board` projection
// (lane, legal moves, reason) to tasks, and executes POST /tasks/:id/move by
// running board-rules.ts's plan through the existing task handlers, so every
// move goes through the same invariants as the equivalent button would. See
// docs/superpowers/specs/2026-09-28-kanban-board-v2-design.md §1.

import {
  boardFor,
  LANES,
  planMove,
  type Board,
  type BoardContext,
  type Lane,
  type MoveStep,
  type PendingPrompt,
  type ReplyChoice,
} from '../../services/board-rules.js';
import {
  describeTaskSchedule,
  isCronTrigger,
  type CronConfig,
} from '../../services/cron-config.js';
import type { ThreadMessageRecord, ThreadStore } from '../../services/thread-store.js';
import type { Task, WorkspaceStore } from '../../services/workspace-store.js';
import type { HandlerFailure, HandlerResult } from './threads.handlers.js';
import {
  answerTaskPrompt,
  enqueueTaskHandler,
  patchTaskHandler,
  pauseTaskHandler,
  withSchedule,
  type TaskResponse,
} from './tasks.handlers.js';

export type BoardTaskResponse = TaskResponse & { board: Board };

// ---------------------------------------------------------------------------
// Board projection
// ---------------------------------------------------------------------------

function promptChoices(payload: Record<string, unknown>): {
  choices: ReplyChoice[];
  allowFreeText: boolean;
} {
  const same = (value: string): ReplyChoice => ({ label: value, value });
  switch (payload.promptKind) {
    case 'shell_approval':
      return {
        choices: [
          { label: 'Deny', value: 'denied' },
          { label: 'Approve & remember', value: 'approved_remember' },
          { label: 'Approve', value: 'approved' },
        ],
        allowFreeText: false,
      };
    case 'yes_no':
      return {
        choices: [
          same(typeof payload.approveLabel === 'string' ? payload.approveLabel : 'Yes'),
          same(typeof payload.rejectLabel === 'string' ? payload.rejectLabel : 'No'),
        ],
        allowFreeText: false,
      };
    case 'multiple_choice':
      return {
        choices: Array.isArray(payload.choices)
          ? payload.choices.filter((c): c is string => typeof c === 'string').map(same)
          : [],
        allowFreeText: payload.allowFreeText === true,
      };
    default:
      return { choices: [], allowFreeText: true };
  }
}

function toPendingPrompt(message: ThreadMessageRecord): PendingPrompt {
  const payload = (message.payload ?? {}) as Record<string, unknown>;
  return {
    threadId: message.threadId,
    promptId: message.id,
    question: typeof payload.question === 'string' ? payload.question : null,
    ...promptChoices(payload),
  };
}

// Builds every task's BoardContext with one query per fact type, however
// many tasks there are — the list endpoint must not go N+1.
export function buildBoardContexts(
  store: WorkspaceStore,
  threadStore: ThreadStore | null,
  tasks: Task[],
  now: Date = new Date(),
): Map<string, BoardContext> {
  const ids = tasks.map((t) => t.id);
  const queue = store.listQueue();
  const entryByTask = new Map(queue.map((entry) => [entry.taskId, entry]));
  const dependencies = store.listDependencyEdgesForTasks(ids);
  const streaks = store.failedRunStreaks(ids);

  // A waiting task's question lives in its parked run's thread.
  const promptThreads = tasks
    .filter((t) => t.status === 'waiting_on_user')
    .map((t) => entryByTask.get(t.id)?.threadId)
    .filter((id): id is string => typeof id === 'string');
  const prompts = threadStore
    ? threadStore.listPendingHitlPrompts(promptThreads)
    : new Map<string, ThreadMessageRecord>();

  const contexts = new Map<string, BoardContext>();
  for (const task of tasks) {
    const entry = entryByTask.get(task.id) ?? null;
    const prompt = entry?.threadId ? prompts.get(entry.threadId) : undefined;
    contexts.set(task.id, {
      queueEntry: entry,
      dependencies: dependencies.get(task.id) ?? [],
      schedule:
        isCronTrigger(task.triggerType) && task.triggerConfig
          ? describeTaskSchedule(
              task.triggerType,
              task.triggerConfig as CronConfig,
              store.countScheduledRuns(task.id),
              now,
            )
          : null,
      pendingPrompt: prompt ? toPendingPrompt(prompt) : null,
      failedStreak: streaks.get(task.id) ?? null,
    });
  }
  return contexts;
}

// Tasks as the API returns them: `schedule` for cron tasks (withSchedule)
// plus the board projection for every task.
export function withBoards(
  store: WorkspaceStore,
  threadStore: ThreadStore | null,
  tasks: Task[],
): BoardTaskResponse[] {
  const contexts = buildBoardContexts(store, threadStore, tasks);
  return tasks.map((task) => ({
    ...withSchedule(store, task),
    board: boardFor(task, contexts.get(task.id)!),
  }));
}

export function withBoard(
  store: WorkspaceStore,
  threadStore: ThreadStore | null,
  task: Task,
): BoardTaskResponse {
  return withBoards(store, threadStore, [task])[0]!;
}

// ---------------------------------------------------------------------------
// POST /tasks/:id/move
// ---------------------------------------------------------------------------

export interface MoveRequest {
  to: Lane;
  position?: number;
  startAt?: string;
  timezone?: string;
  reply?: string;
  assignTo?: 'agent';
}

function badRequest(error: string): HandlerFailure {
  return { ok: false, status: 400, error };
}

function conflict(error: string): HandlerFailure {
  return { ok: false, status: 409, error };
}

function notFound(error: string): HandlerFailure {
  return { ok: false, status: 404, error };
}

export function parseMoveRequest(
  body: Record<string, unknown>,
): { ok: true; move: MoveRequest } | HandlerFailure {
  const { to, position, startAt, timezone, reply, assignTo } = body;
  if (typeof to !== 'string' || !(LANES as readonly string[]).includes(to)) {
    return badRequest(`to must be one of: ${LANES.join(', ')}`);
  }
  if (position !== undefined && (!Number.isInteger(position) || (position as number) < 0)) {
    return badRequest('position must be a non-negative integer');
  }
  if (startAt !== undefined && typeof startAt !== 'string') {
    return badRequest('startAt must be an ISO date-time string');
  }
  if (timezone !== undefined && typeof timezone !== 'string') {
    return badRequest('timezone must be an IANA time zone name');
  }
  if (reply !== undefined && typeof reply !== 'string') {
    return badRequest('reply must be a string');
  }
  if (assignTo !== undefined && assignTo !== 'agent') {
    return badRequest("assignTo must be 'agent'");
  }
  return {
    ok: true,
    move: {
      to: to as Lane,
      position: position as number | undefined,
      startAt: startAt as string | undefined,
      timezone: timezone as string | undefined,
      reply: reply as string | undefined,
      assignTo: assignTo as 'agent' | undefined,
    },
  };
}

// The stored cron config's client-editable fields — resolveCronConfig
// requires the whole client shape on every save, so enabling/disabling
// re-sends it unchanged apart from `enabled`.
function clientCronConfig(task: Task, enabled: boolean): Record<string, unknown> {
  const config = (task.triggerConfig ?? {}) as Record<string, unknown>;
  if (task.triggerType === 'cron_once') {
    return { fireAt: config.fireAt, timezone: config.timezone, enabled };
  }
  return {
    expression: config.expression,
    timezone: config.timezone,
    maxIterations: config.maxIterations ?? null,
    stopAfter: config.stopAfter ?? null,
    maxConsecutiveFailures: config.maxConsecutiveFailures ?? null,
    enabled,
  };
}

function runStep(
  store: WorkspaceStore,
  threadStore: ThreadStore,
  taskId: string,
  step: MoveStep,
  move: MoveRequest,
): HandlerFailure | null {
  const task = store.getTask(taskId)!;
  const fail = (result: HandlerResult<unknown>) => (result.ok ? null : result);

  switch (step.kind) {
    case 'enqueue':
      return fail(enqueueTaskHandler(store, taskId));
    case 'dequeue':
      return store.dequeueTask(taskId) ? null : conflict('The task is no longer queued.');
    case 'detach_paused': {
      const paused = store.listQueue().find((e) => e.taskId === taskId && e.status === 'paused');
      if (paused) store.detachQueueEntry(paused.id);
      return null;
    }
    case 'pause':
      return fail(pauseTaskHandler(store, taskId));
    case 'resume':
      return fail(patchTaskHandler(store, taskId, { status: 'ready' }));
    case 'patch_status':
      return fail(patchTaskHandler(store, taskId, { status: step.status }));
    case 'disable_trigger':
      return fail(
        patchTaskHandler(store, taskId, { triggerConfig: clientCronConfig(task, false) }),
      );
    case 'enable_trigger':
      return fail(patchTaskHandler(store, taskId, { triggerConfig: clientCronConfig(task, true) }));
    case 'clear_trigger':
      return fail(patchTaskHandler(store, taskId, { triggerType: 'manual', triggerConfig: null }));
    case 'save_cron_once':
      return fail(
        patchTaskHandler(store, taskId, {
          triggerType: 'cron_once',
          triggerConfig: { fireAt: move.startAt, timezone: move.timezone, enabled: true },
        }),
      );
    case 'reassign_to_agent':
      return fail(patchTaskHandler(store, taskId, { assignedTo: 'agent' }));
    case 'answer_prompt': {
      const outcome = answerTaskPrompt(store, threadStore, {
        threadId: step.threadId,
        promptId: step.promptId,
        answer: move.reply!,
      });
      return outcome === 'resumed' ? null : conflict('The question has already been answered.');
    }
    case 'reorder':
      return store.reorderQueue(taskId, move.position!)
        ? null
        : conflict('The task is no longer queued.');
    case 'release_dependents':
      store.releaseEligibleDependents(taskId);
      return null;
  }
}

// Executes one board move. The plan is recomputed from fresh state on every
// request, so a card whose `moves` went stale (it started running since the
// board loaded, say) gets a 409 rather than a wrong transition. Steps run in
// order and stop at the first failure.
export function moveTaskHandler(
  store: WorkspaceStore,
  threadStore: ThreadStore,
  taskId: string,
  body: Record<string, unknown>,
): HandlerResult<BoardTaskResponse> {
  const parsed = parseMoveRequest(body);
  if (!parsed.ok) return parsed;
  const { move } = parsed;

  const task = store.getTask(taskId);
  if (!task) return notFound(`Task ${taskId} not found`);

  const ctx = buildBoardContexts(store, threadStore, [task]).get(task.id)!;
  const plan = planMove(task, ctx, move.to);
  if (!plan.ok) return conflict(plan.reason);

  if (plan.needs === 'start_time' && (!move.startAt || !move.timezone)) {
    return badRequest('startAt and timezone are required to schedule a task');
  }
  if (plan.needs === 'reply' && !move.reply?.trim()) {
    return badRequest('reply is required to answer the agent');
  }
  if (plan.needs === 'reassign' && move.assignTo !== 'agent') {
    return badRequest("assignTo: 'agent' is required to hand this task to the agent");
  }
  if (plan.steps.some((s) => s.kind === 'reorder') && move.position === undefined) {
    return badRequest('position is required to reorder the queue');
  }

  for (const step of plan.steps) {
    const failure = runStep(store, threadStore, taskId, step, move);
    if (failure) return failure;
  }

  return { ok: true, data: withBoard(store, threadStore, store.getTask(taskId)!) };
}
