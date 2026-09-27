import { z } from 'zod';
import type { TaskStatus, TriggerType } from './workspace-store.js';
import {
  cronExpressionError,
  isValidTimeZone,
  latestMissedFireAt,
  nextFireAt,
  type CronTiming,
} from './cron-schedule.js';

// trigger_config for the two cron trigger types. The client owns the
// schedule itself; the fields marked server-owned are bookkeeping the
// scheduler writes and are always carried over from the stored config,
// never taken from a request — the same ownership rule webhookToken has.
// See docs/superpowers/specs/2026-09-26-cron-task-triggers-design.md §1.
export interface CronOnceConfig {
  fireAt: string;
  timezone: string;
  enabled: boolean;
  enabledAt: string; // server-owned: when the schedule was last turned on
  lastFiredAt: string | null; // server-owned
}

export interface CronRepeatConfig {
  expression: string;
  timezone: string;
  enabled: boolean;
  maxIterations: number | null; // counts schedule + catch-up runs only
  stopAfter: string | null;
  maxConsecutiveFailures: number | null; // null = never auto-pause
  enabledAt: string; // server-owned
  lastFiredAt: string | null; // server-owned
  consecutiveFailures: number; // server-owned
  pausedReason: 'consecutive_failures' | null; // server-owned
}

export type CronConfig = CronOnceConfig | CronRepeatConfig;

export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

export function isCronTrigger(type: TriggerType): type is 'cron_once' | 'cron_repeat' {
  return type === 'cron_once' || type === 'cron_repeat';
}

const isoDate = z
  .string()
  .refine((v) => !Number.isNaN(new Date(v).getTime()), { message: 'must be a valid date' });

const timezone = z
  .string()
  .refine(isValidTimeZone, { message: 'must be a valid IANA time zone, e.g. America/Chicago' });

const positiveIntOrNull = z.number().int().positive().nullable();

const CronOnceInputSchema = z.object({
  fireAt: isoDate,
  timezone,
  enabled: z.boolean().optional(),
});

const CronRepeatInputSchema = z
  .object({
    expression: z.string().min(1, 'is required'),
    timezone,
    enabled: z.boolean().optional(),
    maxIterations: positiveIntOrNull.optional(),
    stopAfter: isoDate.nullable().optional(),
    maxConsecutiveFailures: positiveIntOrNull.optional(),
  })
  .superRefine((v, ctx) => {
    const err = cronExpressionError(v.expression, v.timezone);
    if (err) ctx.addIssue({ code: 'custom', path: ['expression'], message: err });
  });

export type CronConfigResult = { ok: true; config: CronConfig } | { ok: false; error: string };

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]!;
  const field = issue.path.join('.') || 'triggerConfig';
  return `${field} ${issue.message}`.trim();
}

// Validates a client-supplied cron config and merges it with what is stored.
// `current` is the stored config only when the stored trigger type is the
// same one (switching types starts fresh). Turning a schedule on — creating
// it enabled, or flipping enabled false → true — stamps enabledAt = now and
// clears the failure counter and any auto-pause, so fire times missed while
// it was off are never caught up. Moving a cron_once to a new time re-arms it.
export function resolveCronConfig(
  type: 'cron_once' | 'cron_repeat',
  current: CronConfig | null,
  incoming: unknown,
  now: Date,
): CronConfigResult {
  const nowIso = now.toISOString();

  if (type === 'cron_once') {
    const parsed = CronOnceInputSchema.safeParse(incoming);
    if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
    const prev = current as CronOnceConfig | null;
    const enabled = parsed.data.enabled ?? true;
    const turnedOn = enabled && !(prev?.enabled ?? false);
    const fireAt = new Date(parsed.data.fireAt);
    const moved = prev !== null && new Date(prev.fireAt).getTime() !== fireAt.getTime();
    // A new or moved time in the past would never fire: catch-up only covers
    // times missed while the schedule was on. Reject it rather than park the
    // task at 'scheduled' forever.
    if ((moved || !prev) && fireAt.getTime() <= now.getTime()) {
      return { ok: false, error: 'fireAt must be in the future' };
    }
    return {
      ok: true,
      config: {
        fireAt: fireAt.toISOString(),
        timezone: parsed.data.timezone,
        enabled,
        enabledAt: turnedOn || !prev ? nowIso : prev.enabledAt,
        lastFiredAt: moved || !prev ? null : prev.lastFiredAt,
      },
    };
  }

  const parsed = CronRepeatInputSchema.safeParse(incoming);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const prev = current as CronRepeatConfig | null;
  const enabled = parsed.data.enabled ?? true;
  const turnedOn = enabled && !(prev?.enabled ?? false);
  return {
    ok: true,
    config: {
      expression: parsed.data.expression.trim(),
      timezone: parsed.data.timezone,
      enabled,
      maxIterations: parsed.data.maxIterations ?? null,
      stopAfter: parsed.data.stopAfter ? new Date(parsed.data.stopAfter).toISOString() : null,
      maxConsecutiveFailures:
        parsed.data.maxConsecutiveFailures === undefined
          ? DEFAULT_MAX_CONSECUTIVE_FAILURES
          : parsed.data.maxConsecutiveFailures,
      enabledAt: turnedOn || !prev ? nowIso : prev.enabledAt,
      lastFiredAt: prev?.lastFiredAt ?? null,
      consecutiveFailures: turnedOn ? 0 : (prev?.consecutiveFailures ?? 0),
      pausedReason: turnedOn ? null : (prev?.pausedReason ?? null),
    },
  };
}

// The stored config in the shape cron-schedule's arithmetic takes.
export function cronTiming(type: 'cron_once' | 'cron_repeat', config: CronConfig): CronTiming {
  if (type === 'cron_once') {
    const c = config as CronOnceConfig;
    return {
      kind: 'cron_once',
      fireAt: c.fireAt,
      enabledAt: c.enabledAt,
      lastFiredAt: c.lastFiredAt,
    };
  }
  const c = config as CronRepeatConfig;
  return {
    kind: 'cron_repeat',
    expression: c.expression,
    timezone: c.timezone,
    enabledAt: c.enabledAt,
    lastFiredAt: c.lastFiredAt,
    maxIterations: c.maxIterations,
    stopAfter: c.stopAfter,
  };
}

// Statuses in which a task is doing (or waiting to do) work — a schedule
// edit must never yank it out of these.
const BUSY: ReadonlySet<TaskStatus> = new Set(['ready', 'running', 'waiting_on_user', 'blocked']);

// What an idle cron task's status should be after its schedule is saved:
// 'scheduled' when it will fire again, otherwise off the schedule — back to
// 'pending' if it had been 'scheduled'. null means leave the status alone
// (the task is busy, or not idle-scheduled either way).
export function statusForSavedSchedule(
  currentStatus: TaskStatus,
  type: 'cron_once' | 'cron_repeat',
  config: CronConfig,
  iterationCount: number,
  now: Date,
): TaskStatus | null {
  if (BUSY.has(currentStatus)) return null;
  const timing = cronTiming(type, config);
  const willFire =
    config.enabled &&
    (nextFireAt(timing, now, iterationCount) !== null ||
      // a cron_once whose time passed while it was on but unfired (it was
      // busy with a manual run at the time) still fires once, as a
      // catch-up — so it stays scheduled.
      (type === 'cron_once' && latestMissedFireAt(timing, now, iterationCount) !== null));
  if (willFire) return 'scheduled';
  return currentStatus === 'scheduled' ? 'pending' : null;
}

// Why a cron schedule will not fire again, for the drawer's banner:
// turned off by hand, auto-paused after failures, out of runs, past
// stopAfter (or a one-shot time that can no longer fire), or a one-shot that
// already fired.
export type ScheduleInactiveReason = 'disabled' | 'failures' | 'exhausted' | 'expired' | 'fired';

export interface TaskSchedule {
  nextFireAt: string | null;
  iterationCount: number;
  active: boolean;
  inactiveReason: ScheduleInactiveReason | null;
}

// The computed `schedule` field on a cron task's API responses.
export function describeTaskSchedule(
  type: 'cron_once' | 'cron_repeat',
  config: CronConfig,
  iterationCount: number,
  now: Date,
): TaskSchedule {
  const inactive = (inactiveReason: ScheduleInactiveReason): TaskSchedule => ({
    nextFireAt: null,
    iterationCount,
    active: false,
    inactiveReason,
  });
  const timing = cronTiming(type, config);

  if (type === 'cron_once') {
    const c = config as CronOnceConfig;
    if (!c.enabled) return inactive('disabled');
    if (c.lastFiredAt !== null) return inactive('fired');
    // Due but unfired (it was busy at its time) fires as soon as it's idle.
    const next =
      nextFireAt(timing, now, iterationCount) ?? latestMissedFireAt(timing, now, iterationCount);
    if (!next) return inactive('expired');
    return { nextFireAt: next.toISOString(), iterationCount, active: true, inactiveReason: null };
  }

  const c = config as CronRepeatConfig;
  if (!c.enabled) {
    return inactive(c.pausedReason === 'consecutive_failures' ? 'failures' : 'disabled');
  }
  const next = nextFireAt(timing, now, iterationCount);
  if (!next) {
    return inactive(
      c.maxIterations !== null && iterationCount >= c.maxIterations ? 'exhausted' : 'expired',
    );
  }
  return { nextFireAt: next.toISOString(), iterationCount, active: true, inactiveReason: null };
}
