import type { TaskStatus, TriggerSource } from './workspace-store.js';
import {
  cronTiming,
  type CronConfig,
  type CronOnceConfig,
  type CronRepeatConfig,
} from './cron-config.js';
import { nextFireAt } from './cron-schedule.js';

export interface CronRunSettlementInput {
  type: 'cron_once' | 'cron_repeat';
  config: CronConfig;
  source: TriggerSource;
  outcome: 'done' | 'failed' | 'cancelled';
  // Schedule + catch-up runs so far, including the one settling now.
  iterationCount: number;
  now: Date;
}

export interface CronRunSettlement {
  status: TaskStatus;
  config: CronConfig;
}

const SCHEDULED_SOURCES: ReadonlySet<TriggerSource> = new Set(['schedule', 'catch_up']);

// What a cron task becomes once one of its runs finishes. Pure — the store
// applies the result. The rules (design §2 "Run settlement"):
// - A recurring task goes back to 'scheduled' after every run, and only
//   leaves it when the schedule runs out ('done') or pauses itself.
// - Only runs the schedule started move its failure counter: a failure adds
//   one, a success resets it, a cancel leaves it. Reaching
//   maxConsecutiveFailures turns the schedule off ('pending').
// - A manual "Run now" never touches the counters, so troubleshooting a
//   failing schedule by hand doesn't use up its budget or reset its streak.
// - A one-shot ends like any task once its scheduled run finishes; a manual
//   run before it has fired leaves it waiting for its time.
export function settleCronRun(input: CronRunSettlementInput): CronRunSettlement {
  const scheduledRun = SCHEDULED_SOURCES.has(input.source);

  if (input.type === 'cron_once') {
    const config = input.config as CronOnceConfig;
    if (!scheduledRun && config.lastFiredAt === null) {
      return { status: config.enabled ? 'scheduled' : 'pending', config };
    }
    return { status: input.outcome, config };
  }

  let config = input.config as CronRepeatConfig;
  if (scheduledRun) {
    const consecutiveFailures =
      input.outcome === 'failed'
        ? config.consecutiveFailures + 1
        : input.outcome === 'done'
          ? 0
          : config.consecutiveFailures;
    config = { ...config, consecutiveFailures };
    if (
      config.maxConsecutiveFailures !== null &&
      consecutiveFailures >= config.maxConsecutiveFailures
    ) {
      return {
        status: 'pending',
        config: { ...config, enabled: false, pausedReason: 'consecutive_failures' },
      };
    }
  }

  if (!config.enabled) return { status: 'pending', config };
  const next = nextFireAt(cronTiming('cron_repeat', config), input.now, input.iterationCount);
  return { status: next ? 'scheduled' : 'done', config };
}
