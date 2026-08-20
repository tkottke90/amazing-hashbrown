import { getWorkspaceStore } from './workspace-store.js';
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

// Event-driven, not polling: the scheduler only does work in response to a
// signal that something may have changed — a task was enqueued, the running
// task finished, or the scheduler resumed from a chat pause. See issue #68:
//   Task dequeued => Task executed => Task completed => New Task? == No  => Idle
//                                                                  == Yes => Continue
export class TaskScheduler {
  private paused = false;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;

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
    // TODO: invoke task agent when agent integration is implemented, oriented
    // to the task's workspace wiki (workspaces.wiki_id via WikiRegistry —
    // see api/src/services/wiki.ts); for now just mark as running — the
    // agent will call completeQueueEntry() and then scheduler.wake() when done.
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

export function bootTaskScheduler(): TaskScheduler {
  _scheduler = new TaskScheduler();
  _scheduler.start();
  return _scheduler;
}

export function getTaskScheduler(): TaskScheduler {
  if (!_scheduler) {
    throw new Error('Task scheduler not initialised — call bootTaskScheduler() first');
  }
  return _scheduler;
}
