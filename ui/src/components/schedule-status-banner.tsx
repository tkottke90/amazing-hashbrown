import type { TaskSchedule } from '@/services/tasks-api';
import { formatFireTime, inactiveScheduleMessage } from '@/lib/cron-drafts';

// The schedule's on/off switch, plus where the saved schedule stands: its
// next run, or why it won't run again.
export function ScheduleStatusBanner({
  enabled,
  onEnabledChange,
  schedule,
  config,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  schedule?: TaskSchedule;
  config: unknown;
}) {
  return (
    <div class="flex flex-col gap-1.5" data-testid="schedule-status">
      <label class="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          data-testid="schedule-enabled"
          checked={enabled}
          onChange={(e) => onEnabledChange((e.target as HTMLInputElement).checked)}
        />
        Schedule enabled
      </label>
      {schedule && !schedule.active && schedule.inactiveReason && (
        <p
          data-testid="schedule-inactive-banner"
          data-reason={schedule.inactiveReason}
          class="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400"
        >
          {inactiveScheduleMessage(schedule.inactiveReason, schedule, config)}
        </p>
      )}
      {schedule?.active && schedule.nextFireAt && (
        <p data-testid="schedule-next-run" class="text-xs text-muted-foreground">
          Next run: {formatFireTime(schedule.nextFireAt)}
        </p>
      )}
    </div>
  );
}
