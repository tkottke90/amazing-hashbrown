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

function localDayKey(date: Date, timeZone: string): string {
  // en-CA gives YYYY-MM-DD, which compares correctly as a plain string.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

// Walking further back than this many matches means the expression is
// pathological for a single calendar day (e.g. "* * * * *" could match up
// to 1440 times) — bail out rather than loop unbounded.
const LAPSED_FIRES_ITERATION_CAP = 1500;

// Matches of a cron_repeat expression between local midnight (in its own
// timezone) and `now` — fire times that will never run because they precede
// the enabledAt about to be stamped. See GLOSSARY.md "Lapsed Fire". Meant to
// be called only at the moment resolveCronConfig (re)stamps enabledAt.
// Returns matches oldest first.
export function lapsedFiresToday(timing: CronRepeatTiming, now: Date): Date[] {
  const today = localDayKey(now, timing.timezone);
  const matches: Date[] = [];
  // Starting 1 ms past `now` makes the first prev() call return a match
  // exactly at `now` too — the same "exact-now counts" idiom
  // latestMissedFireAt uses.
  let currentDate = new Date(now.getTime() + 1);
  for (let i = 0; i < LAPSED_FIRES_ITERATION_CAP; i++) {
    let match: Date;
    try {
      match = CronExpressionParser.parse(timing.expression.trim(), {
        currentDate,
        tz: timing.timezone,
      })
        .prev()
        .toDate();
    } catch {
      break;
    }
    if (localDayKey(match, timing.timezone) !== today) break;
    matches.push(match);
    // The next call's currentDate is this match itself (not +1 ms): prev()
    // with currentDate = X returns the latest match strictly before X.
    currentDate = match;
  }
  return matches.reverse();
}

const MAX_LISTED_LAPSED_FIRES = 5;

// Renders Lapsed Fire times into the warning text shared verbatim by every
// surface that can create/re-enable a cron_repeat schedule (the REST
// response, the create_tasks tool, the cron preview endpoint). Undefined
// when there's nothing to warn about, so callers can spread it in with no
// extra `if`.
export function describeLapsedFires(lapsed: Date[], timezone: string): string | undefined {
  if (lapsed.length === 0) return undefined;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const listed = lapsed.slice(0, MAX_LISTED_LAPSED_FIRES).map((d) => fmt.format(d));
  const overflow = lapsed.length - listed.length;
  const times =
    overflow > 0
      ? `${listed.join(', ')}, +${overflow} more`
      : listed.length === 1
        ? listed[0]!
        : `${listed.slice(0, -1).join(', ')} and ${listed[listed.length - 1]}`;
  const plural = lapsed.length === 1 ? 'run' : 'runs';
  return (
    `Heads up: today's ${times} ${plural} already passed and won't fire. ` +
    'The schedule will run normally starting with its next fire time.'
  );
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
