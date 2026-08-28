import { getWorkspaceStore, type Task, type TaskQueueEntry } from './workspace-store.js';
import { logger } from '../config/logger.js';

// Overridable so e2e tests don't have to wait 30 real seconds per pause/resume
// assertion — playwright.config.ts sets CHAT_IDLE_RESUME_MS to a few seconds
// for the e2e webServer. Unset in dev/prod, where it stays 30s.
const CHAT_IDLE_RESUME_MS = Number(process.env['CHAT_IDLE_RESUME_MS']) || 30_000;

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
// signal that something may have changed — a task was enqueued, the running
// task finished, or the scheduler resumed from a chat pause. See issue #68:
//   Task dequeued => Task executed => Task completed => New Task? == No  => Idle
//                                                                  == Yes => Continue
export class TaskScheduler {
  private paused = false;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private executor: TaskExecutor | null;

  constructor(executor?: TaskExecutor) {
    this.executor = executor ?? null;
  }

  // Picks up any work left over from a previous run (e.g. tasks that were
  // still pending when the process last stopped).
  start(): void {
    this.wake();
  }

  stop(): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  // Pauses the queue for an active chat turn. If a task is currently
  // running it is put back to `paused` (re-queued as pending on resume)
  // rather than left running underneath the chat turn; if the scheduler
  // was already idle this just sets the flag.
  pause(): void {
    this.paused = true;
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    const store = getWorkspaceStore();
    const running = store.getRunningEntry();
    if (running) {
      store.pauseQueueEntry(running.id);
    }
    this.wake();
  }

  // Arms (or re-arms) the 30s idle timer. Called after each chat response
  // is sent; a new chat message before the timer fires calls pause() again,
  // which clears and effectively resets it.
  scheduleResume(): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resume();
    }, CHAT_IDLE_RESUME_MS);
  }

  resume(): void {
    this.paused = false;
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    const store = getWorkspaceStore();
    const pausedEntry = store.listQueue().find((e) => e.status === 'paused');
    if (pausedEntry) {
      store.resumePausedEntry(pausedEntry.id);
    }
    // Pick up the next pending task immediately if there is one; if the
    // queue was empty this is a no-op and the scheduler just stays idle.
    this.wake();
  }

  isPaused(): boolean {
    return this.paused;
  }

  // Entry point for "something may have changed, check if there's work to
  // do now". Safe to call any time: it's a no-op while paused (beyond
  // broadcasting the current state), and a no-op while a task is already
  // running. Call this whenever new work becomes available — a task is
  // enqueued, a running task completes, or the scheduler resumes.
  wake(): void {
    if (!this.paused) {
      try {
        this.tick();
      } catch (err: unknown) {
        logger.warn('Task scheduler tick error', { err: String(err) });
      }
    }
    this.emitQueueUpdate();
  }

  private tick(): void {
    const store = getWorkspaceStore();

    // Don't start a new item if one is already running
    if (store.getRunningEntry()) return;

    const next = store.dequeueNext();
    if (!next) return;

    logger.info('Task scheduler: starting task', { taskId: next.taskId, queueId: next.id });
    if (!this.executor) {
      logger.warn('Task scheduler: no executor registered — task left running', {
        taskId: next.taskId,
      });
      return;
    }
    void this.runTask(next);
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
    const running = store.getRunningEntry();
    const payload = { queue, running: running ?? null, paused: this.paused };
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
