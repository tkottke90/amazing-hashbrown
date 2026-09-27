import { CronExpressionParser } from 'cron-parser';
import cronstrue from 'cronstrue';

// Pure schedule arithmetic for cron-triggered tasks: no timers, no database.
// Every consumer — the registry's timer, the drawer's preview, a task's
// `schedule` field and boot catch-up — asks these functions, so the time the
// user is shown is the time the task actually fires. See
// docs/superpowers/specs/2026-09-26-cron-task-triggers-design.md §2.

export interface CronOnceTiming {
  kind: 'cron_once';
  fireAt: string; // ISO datetime
  enabledAt: string;
  lastFiredAt: string | null;
}

export interface CronRepeatTiming {
  kind: 'cron_repeat';
  expression: string;
  timezone: string;
  enabledAt: string;
  lastFiredAt: string | null;
  maxIterations: number | null;
  stopAfter: string | null;
}

export type CronTiming = CronOnceTiming | CronRepeatTiming;

// The standard 5-field form only (minute hour day-of-month month
// day-of-week). cron-parser also accepts a leading seconds field and
// silently pads shorter strings; neither is something a user typing a
// schedule into the drawer should get by accident.
const CRON_FIELD_COUNT = 5;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// null when the expression is usable in the given zone; otherwise a message
// fit to show the user as an inline error.
export function cronExpressionError(expression: string, timeZone: string): string | null {
  const fields = expression.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== CRON_FIELD_COUNT) {
    return `Use the 5-field form "minute hour day-of-month month day-of-week" (got ${fields.length} field${fields.length === 1 ? '' : 's'}).`;
  }
  if (!isValidTimeZone(timeZone)) return `Unknown time zone "${timeZone}".`;
  try {
    CronExpressionParser.parse(expression.trim(), { tz: timeZone }).next();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function nextMatch(expression: string, timeZone: string, after: Date): Date | null {
  try {
    return CronExpressionParser.parse(expression.trim(), { currentDate: after, tz: timeZone })
      .next()
      .toDate();
  } catch {
    return null;
  }
}

// The next time this schedule should fire strictly after `after`, or null
// when it never will again: a cron_once whose time has passed, or a
// cron_repeat that has used up maxIterations or would next fire past
// stopAfter. iterationCount is how many schedule/catch-up runs have
// happened so far.
export function nextFireAt(timing: CronTiming, after: Date, iterationCount: number): Date | null {
  if (timing.kind === 'cron_once') {
    const fireAt = new Date(timing.fireAt);
    return fireAt > after ? fireAt : null;
  }
  if (timing.maxIterations !== null && iterationCount >= timing.maxIterations) return null;
  const next = nextMatch(timing.expression, timing.timezone, after);
  if (!next) return null;
  if (timing.stopAfter !== null && next > new Date(timing.stopAfter)) return null;
  return next;
}

// The most recent fire time that came due in (since, now], where since is
// the later of the last fire and when the schedule was (re-)enabled — so
// fire times missed while the schedule was turned off are never caught up.
// Returns a single time even when many were missed: the server being off
// for a week yields one catch-up run, not seven.
export function latestMissedFireAt(
  timing: CronTiming,
  now: Date,
  iterationCount: number,
): Date | null {
  const since = new Date(
    Math.max(
      new Date(timing.enabledAt).getTime(),
      timing.lastFiredAt ? new Date(timing.lastFiredAt).getTime() : 0,
    ),
  );

  if (timing.kind === 'cron_once') {
    if (timing.lastFiredAt !== null) return null;
    const fireAt = new Date(timing.fireAt);
    return fireAt > since && fireAt <= now ? fireAt : null;
  }

  if (timing.maxIterations !== null && iterationCount >= timing.maxIterations) return null;
  let latest: Date;
  try {
    // Starting 1 ms past `now` makes prev() return the latest match at or
    // before now — a fire time exactly at `now` counts as due.
    latest = CronExpressionParser.parse(timing.expression.trim(), {
      currentDate: new Date(now.getTime() + 1),
      tz: timing.timezone,
    })
      .prev()
      .toDate();
  } catch {
    return null;
  }
  if (latest <= since) return null;
  if (timing.stopAfter !== null && latest > new Date(timing.stopAfter)) return null;
  return latest;
}

export interface CronDescription {
  description: string;
  nextFireTimes: Date[];
}

// For the drawer's live preview: a human-readable reading of the schedule
// and the next few times it will fire from `now`.
export function describeSchedule(
  timing: CronTiming,
  now: Date,
  iterationCount = 0,
  count = 3,
): CronDescription {
  if (timing.kind === 'cron_once') {
    const next = nextFireAt(timing, now, iterationCount);
    return { description: 'Once', nextFireTimes: next ? [next] : [] };
  }
  const nextFireTimes: Date[] = [];
  let after = now;
  for (let i = 0; i < count; i++) {
    const next = nextFireAt(timing, after, iterationCount + i);
    if (!next) break;
    nextFireTimes.push(next);
    after = next;
  }
  return {
    description: cronstrue.toString(timing.expression.trim(), { verbose: false }),
    nextFireTimes,
  };
}
