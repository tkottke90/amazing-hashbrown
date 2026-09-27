import type {
  CronOnceConfig,
  CronRepeatConfig,
  ScheduleInactiveReason,
  TaskSchedule,
  TriggerType,
} from '@/services/tasks-api';

// The drawer edits a schedule as strings (what its inputs hold) and converts
// to/from the stored trigger_config only at the edges. The server validates;
// these helpers only reshape.

export interface CronOnceDraft {
  fireAt: string; // <input type="datetime-local"> value, in the browser's zone
  timezone: string;
  enabled: boolean;
}

export interface CronRepeatDraft {
  expression: string;
  timezone: string;
  enabled: boolean;
  maxIterations: string; // '' = unlimited
  stopAfter: string; // <input type="date"> value; '' = never
  maxConsecutiveFailures: string; // '' = never auto-pause
}

export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

export function isCronTrigger(type: TriggerType): type is 'cron_once' | 'cron_repeat' {
  return type === 'cron_once' || type === 'cron_repeat';
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const pad = (n: number) => String(n).padStart(2, '0');

// ISO instant → "YYYY-MM-DDTHH:mm" in the browser's zone.
export function toLocalDateTimeInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ISO instant → "YYYY-MM-DD" in the browser's zone.
export function toLocalDateInput(iso: string): string {
  return toLocalDateTimeInput(iso).slice(0, 10);
}

export function onceDraftFrom(config: unknown): CronOnceDraft {
  const c = config as Partial<CronOnceConfig> | null;
  return {
    fireAt: c?.fireAt ? toLocalDateTimeInput(c.fireAt) : '',
    // A one-shot's time is entered in the browser's zone; the stored zone
    // is informational.
    timezone: browserTimeZone(),
    enabled: c?.enabled ?? true,
  };
}

export function repeatDraftFrom(config: unknown): CronRepeatDraft {
  const c = config as Partial<CronRepeatConfig> | null;
  const failures =
    c?.maxConsecutiveFailures === undefined
      ? DEFAULT_MAX_CONSECUTIVE_FAILURES
      : c.maxConsecutiveFailures;
  return {
    expression: c?.expression ?? '',
    timezone: c?.timezone ?? browserTimeZone(),
    enabled: c?.enabled ?? true,
    maxIterations: c?.maxIterations != null ? String(c.maxIterations) : '',
    stopAfter: c?.stopAfter ? toLocalDateInput(c.stopAfter) : '',
    maxConsecutiveFailures: failures === null ? '' : String(failures),
  };
}

// A blank or unparseable time sends a string the server rejects with a
// field message — never silently drops the field.
export function onceConfigFrom(
  draft: CronOnceDraft,
): Pick<CronOnceConfig, 'fireAt' | 'timezone' | 'enabled'> {
  const at = new Date(draft.fireAt);
  return {
    fireAt: Number.isNaN(at.getTime()) ? draft.fireAt : at.toISOString(),
    timezone: draft.timezone,
    enabled: draft.enabled,
  };
}

const intOrNull = (v: string): number | null => (v.trim() === '' ? null : Number(v.trim()));

export function repeatConfigFrom(
  draft: CronRepeatDraft,
): Pick<
  CronRepeatConfig,
  'expression' | 'timezone' | 'enabled' | 'maxIterations' | 'stopAfter' | 'maxConsecutiveFailures'
> {
  return {
    expression: draft.expression.trim(),
    timezone: draft.timezone.trim(),
    enabled: draft.enabled,
    maxIterations: intOrNull(draft.maxIterations),
    // "Stop after Sep 30" includes Sep 30's runs: the end of that day.
    stopAfter: draft.stopAfter ? new Date(`${draft.stopAfter}T23:59:59.999`).toISOString() : null,
    maxConsecutiveFailures: intOrNull(draft.maxConsecutiveFailures),
  };
}

export function formatFireTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// The drawer banner's wording for a schedule that won't fire again.
export function inactiveScheduleMessage(
  reason: ScheduleInactiveReason,
  schedule: Pick<TaskSchedule, 'iterationCount'>,
  config: unknown,
): string {
  const c = config as Partial<CronRepeatConfig & CronOnceConfig> | null;
  switch (reason) {
    case 'failures':
      return `Paused after ${c?.consecutiveFailures ?? c?.maxConsecutiveFailures} consecutive failures`;
    case 'exhausted':
      return `Finished — ${schedule.iterationCount} of ${c?.maxIterations ?? schedule.iterationCount} runs`;
    case 'expired':
      return c?.stopAfter
        ? `Stopped — past ${new Date(c.stopAfter).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
        : 'Its scheduled time has passed';
    case 'fired':
      return c?.lastFiredAt ? `Fired on ${formatFireTime(c.lastFiredAt)}` : 'Already fired';
    case 'disabled':
      return 'Schedule is off';
  }
}
