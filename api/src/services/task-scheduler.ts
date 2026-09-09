import { getWorkspaceStore, type Task, type TaskQueueEntry } from './workspace-store.js';
import { logger } from '../config/logger.js';

// Broadcast callback registered by stream-handler so the scheduler can emit
// queue update events into all active SSE connections without importing the
// full stream-handler tree (which would create a circular dependency).
type BroadcastFn = (eventJson: string) => void;
let _broadcast: BroadcastFn | null = null;

export function registerQueueBroadcast(fn: BroadcastFn): void {
  _broadcast = fn;
}

// Runs one dequeued task to completion (or to a waiting_on_user pause) and
// mirrors the outcome onto tasks/task_queue — see task-execution.ts's
// executeTask(), the real implementation. Injected via the constructor
// (bootTaskScheduler()) rather than imported directly here, for the same
// reason registerQueueBroadcast() above exists as a callback instead of an
// import: task-execution.ts imports pipeEvents/finalizeTurn from
// stream-handler.ts, which already imports getTaskScheduler() from this
// file — a direct import here would complete that cycle.
export type TaskExecutor = (entry: TaskQueueEntry & { task: Task }) => Promise<void>;

// Event-driven, not polling: the scheduler only does work in response to a
// signal that something may have changed — a task was enqueued, or a
// running task finished. See issue #68:
//   Task dequeued => Task executed => Task completed => New Task? == No  => Idle
//                                                                  == Yes => Continue
export class TaskScheduler {
  private executor: TaskExecutor | null;

  constructor(executor?: TaskExecutor) {
    this.executor = executor ?? null;
  }

  // Picks up any work left over from a previous run (e.g. tasks that were
  // still pending when the process last stopped).
  start(): void {
    this.wake();
  }

  // Entry point for "something may have changed, check if there's work to
  // do now". Safe to call any time: it's a no-op while no scope has
  // eligible pending work. Call this whenever new work becomes available —
  // a task is enqueued, or a running task completes.
  wake(): void {
    try {
      this.tick();
    } catch (err: unknown) {
      logger.warn('Task scheduler tick error', { err: String(err) });
    }
    this.emitQueueUpdate();
  }

  // Dequeues and dispatches every currently-eligible task, not just one —
  // dequeueNext() only ever claims a single scope per call (each call marks
  // that scope's entry 'running', making it ineligible for the next call),
  // so draining every scope with pending work in one tick requires looping
  // until dequeueNext() finds nothing left to dispatch. This is what lets
  // e.g. an Inbox task and a workspace task both reach 'running' from one
  // wake() — see dequeueNext()'s own comment in workspace-store.ts.
  private tick(): void {
    const store = getWorkspaceStore();

    let next = store.dequeueNext();
    while (next) {
      logger.info('Task scheduler: starting task', { taskId: next.taskId, queueId: next.id });
      if (!this.executor) {
        logger.warn('Task scheduler: no executor registered — task left running', {
          taskId: next.taskId,
        });
        return;
      }
      void this.runTask(next);
      next = store.dequeueNext();
    }
  }

  // Fire-and-forget from tick()'s point of view — tick() itself stays
  // synchronous. Always wakes the scheduler again afterward (success or
  // failure) so the next queued item, if any, gets picked up; the executor
  // itself is responsible for never leaving a task stuck in 'running' (see
  // task-execution.ts), but this catch is the last-resort backstop.
  private async runTask(entry: TaskQueueEntry & { task: Task }): Promise<void> {
    try {
      await this.executor!(entry);
    } catch (err: unknown) {
      logger.error('Task scheduler: executeTask failed unexpectedly', {
        taskId: entry.taskId,
        err: String(err),
      });
    } finally {
      this.wake();
    }
  }

  private emitQueueUpdate(): void {
    if (!_broadcast) return;
    const store = getWorkspaceStore();
    const queue = store.listQueue();
    const running = store.getRunningEntries();
    const payload = { queue, running };
    _broadcast(JSON.stringify({ type: 'task_queue_update', data: payload }));
  }
}

// ---------------------------------------------------------------------------
// Boot wiring
// ---------------------------------------------------------------------------

let _scheduler: TaskScheduler | null = null;

export function bootTaskScheduler(executor?: TaskExecutor): TaskScheduler {
  _scheduler = new TaskScheduler(executor);
  _scheduler.start();
  return _scheduler;
}

export function getTaskScheduler(): TaskScheduler {
  if (!_scheduler) {
    throw new Error('Task scheduler not initialised — call bootTaskScheduler() first');
  }
  return _scheduler;
}
