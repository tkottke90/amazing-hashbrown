import { getWorkspaceStore } from './workspace-store.js';
import { logger } from '../config/logger.js';

const POLL_INTERVAL_MS = 5_000;
const CHAT_IDLE_RESUME_MS = 30_000;

// Broadcast callback registered by stream-handler so the scheduler can emit
// queue update events into all active SSE connections without importing the
// full stream-handler tree (which would create a circular dependency).
type BroadcastFn = (eventJson: string) => void;
let _broadcast: BroadcastFn | null = null;

export function registerQueueBroadcast(fn: BroadcastFn): void {
  _broadcast = fn;
}

export class TaskScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private paused = false;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.paused) {
        this.tick().catch((err: unknown) => {
          logger.warn('Task scheduler tick error', { err: String(err) });
        });
      }
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

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
    this.emitQueueUpdate();
  }

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
    const paused = store.listQueue().find((e) => e.status === 'paused');
    if (paused) {
      store.resumePausedEntry(paused.id);
    }
    this.emitQueueUpdate();
  }

  isPaused(): boolean {
    return this.paused;
  }

  private async tick(): Promise<void> {
    const store = getWorkspaceStore();

    // Don't start a new item if one is already running
    if (store.getRunningEntry()) return;

    const next = store.dequeueNext();
    if (!next) return;

    logger.info('Task scheduler: starting task', { taskId: next.taskId, queueId: next.id });
    this.emitQueueUpdate();

    try {
      // TODO: invoke task agent when agent integration is implemented
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      store.completeQueueEntry(next.id, 'done');
    } catch (err) {
      logger.warn('Task scheduler: task failed', { taskId: next.taskId, err: String(err) });
      store.completeQueueEntry(next.id, 'failed');
    }

    this.emitQueueUpdate();
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
