import { logger } from '../config/logger.js';
import { getWorkspaceStore, type Task, type WorkspaceStore } from './workspace-store.js';
import { getTaskScheduler, type TaskExecutor } from './task-scheduler.js';
import { cronTiming, isCronTrigger, type CronConfig } from './cron-config.js';
import { latestMissedFireAt, nextFireAt } from './cron-schedule.js';

// setTimeout's delay is a signed 32-bit int; anything larger fires at once.
// Longer waits are armed in chunks and re-evaluated on each wake.
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export interface CronRegistryDeps {
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  store?: () => WorkspaceStore;
  // Called after a fire enqueued a run — the scheduler picks it up.
  onEnqueued?: () => void;
}

interface ArmedTimer {
  handle: unknown;
  fireAt: Date;
}

// One in-process timer per cron task, armed for its next fire time. The
// database is the source of truth — a timer is only ever a wake-up call:
// every wake re-reads the task and fires through store.fireCronTask(),
// whose gate ('scheduled' and enabled) decides whether the fire happens.
// A task that is busy at its fire time skips that fire; settlement re-arms
// it afterwards. See docs/superpowers/specs/2026-09-26-cron-task-triggers-design.md §2.
export class CronRegistry {
  private readonly timers = new Map<string, ArmedTimer>();
  private readonly now: () => Date;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly store: () => WorkspaceStore;
  private readonly onEnqueued: () => void;

  constructor(deps: CronRegistryDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.store = deps.store ?? getWorkspaceStore;
    this.onEnqueued = deps.onEnqueued ?? (() => getTaskScheduler().wake());
  }

  // Loads every task waiting on its schedule. One missed fire time while the
  // server was down becomes one catch-up run — never a backlog.
  boot(): void {
    let tasks: Task[] = [];
    try {
      tasks = this.store().listScheduledTasks();
    } catch (err) {
      logger.error('cron-registry: boot failed to list scheduled tasks', { err: String(err) });
    }
    for (const task of tasks) {
      try {
        const config = task.triggerConfig as CronConfig | null;
        if (isCronTrigger(task.triggerType) && config?.enabled) {
          const missed = latestMissedFireAt(
            cronTiming(task.triggerType, config),
            this.now(),
            this.store().countScheduledRuns(task.id),
          );
          if (missed) this.fire(task.id, missed, 'catch_up');
        }
      } catch (err) {
        logger.error('cron-registry: boot catch-up failed', { taskId: task.id, err: String(err) });
      }
      this.sync(task.id);
    }
    logger.info('cron-registry: booted', { armed: this.timers.size });
  }

  // Re-reads the task and (re-)arms its timer, or clears it when the task no
  // longer waits on a schedule. Call after anything that may change a cron
  // task's trigger, status or existence. Never throws.
  sync(taskId: string): void {
    this.clear(taskId);
    try {
      const task = this.store().getTask(taskId);
      if (!task || !isCronTrigger(task.triggerType) || task.status !== 'scheduled') return;
      const config = task.triggerConfig as CronConfig | null;
      if (!config?.enabled) return;

      const timing = cronTiming(task.triggerType, config);
      const now = this.now();
      const count = this.store().countScheduledRuns(taskId);
      const next = nextFireAt(timing, now, count);
      if (next) {
        this.arm(taskId, next);
        return;
      }
      // A one-shot whose time came while it was busy with a manual run
      // still fires once, now. (A skipped recurring fire just waits for
      // the next one.)
      if (task.triggerType === 'cron_once') {
        const missed = latestMissedFireAt(timing, now, count);
        if (missed) this.fire(taskId, missed, 'catch_up');
      }
    } catch (err) {
      logger.error('cron-registry: sync failed', { taskId, err: String(err) });
    }
  }

  // Re-syncs every armed task — for bulk changes (a workspace delete) where
  // the affected ids aren't at hand. Tasks that are gone get cleared.
  resyncAll(): void {
    for (const taskId of [...this.timers.keys()]) this.sync(taskId);
  }

  // Starts one run for the given fire time if the task is idle on its
  // schedule. Never throws.
  fire(taskId: string, scheduledFor: Date, source: 'schedule' | 'catch_up'): void {
    if (this.now().getTime() < scheduledFor.getTime()) {
      // Early wake (a chunked long wait, or timer drift) — just re-arm.
      this.sync(taskId);
      return;
    }
    let entry;
    try {
      entry = this.store().fireCronTask(taskId, scheduledFor.toISOString(), source);
    } catch (err) {
      logger.error('cron-registry: fire failed', { taskId, err: String(err) });
      return;
    }
    if (!entry) {
      logger.debug('cron-registry: fire skipped — task not idle on its schedule', {
        taskId,
        scheduledFor: scheduledFor.toISOString(),
      });
      this.sync(taskId);
      return;
    }
    logger.info('cron-registry: fired', {
      taskId,
      source,
      scheduledFor: scheduledFor.toISOString(),
    });
    try {
      this.onEnqueued();
    } catch (err) {
      logger.error('cron-registry: waking the scheduler failed', { taskId, err: String(err) });
    }
  }

  // The fire time each task is currently armed for (for diagnostics/tests).
  armedFor(taskId: string): Date | null {
    return this.timers.get(taskId)?.fireAt ?? null;
  }

  stop(): void {
    for (const taskId of [...this.timers.keys()]) this.clear(taskId);
  }

  private arm(taskId: string, fireAt: Date): void {
    const delay = Math.max(0, fireAt.getTime() - this.now().getTime());
    const handle = this.setTimer(
      () => {
        this.timers.delete(taskId);
        this.fire(taskId, fireAt, 'schedule');
      },
      Math.min(delay, MAX_TIMER_DELAY_MS),
    );
    this.timers.set(taskId, { handle, fireAt });
  }

  private clear(taskId: string): void {
    const armed = this.timers.get(taskId);
    if (!armed) return;
    this.clearTimer(armed.handle);
    this.timers.delete(taskId);
  }
}

// Wraps the task executor so every run — however it ends — re-syncs its
// task's schedule afterwards: settlement usually puts a cron task back to
// 'scheduled', and this arms its next fire.
export function withCronResync(executor: TaskExecutor, registry: () => CronRegistry): TaskExecutor {
  return async (entry) => {
    try {
      await executor(entry);
    } finally {
      registry().sync(entry.taskId);
    }
  };
}

// ---------------------------------------------------------------------------
// Boot wiring
// ---------------------------------------------------------------------------

let _registry: CronRegistry | null = null;

export function bootCronRegistry(deps?: CronRegistryDeps): CronRegistry {
  _registry?.stop();
  _registry = new CronRegistry(deps);
  _registry.boot();
  return _registry;
}

export function getCronRegistry(): CronRegistry {
  if (!_registry) {
    throw new Error('Cron registry not initialised — call bootCronRegistry() first');
  }
  return _registry;
}
