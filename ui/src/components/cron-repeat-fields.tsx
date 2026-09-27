import type { Signal } from '@preact/signals';
import { Input } from '@/components/ui/input';
import type { CronRepeatDraft } from '@/lib/cron-drafts';

type TextField = Exclude<keyof CronRepeatDraft, 'enabled'>;

// Scheduled (repeat): a 5-field cron expression in a time zone, plus the
// limits that end or pause it.
export function CronRepeatFields({ draft }: { draft: Signal<CronRepeatDraft> }) {
  const bind = (field: TextField) => ({
    value: draft.value[field],
    onInput: (e: Event) => {
      draft.value = { ...draft.value, [field]: (e.target as HTMLInputElement).value };
    },
  });

  return (
    <div class="flex flex-col gap-2" data-testid="cron-repeat-fields">
      <div class="flex flex-col gap-1">
        <label class="text-xs text-muted-foreground" for="cron-expression">
          Cron expression
        </label>
        <Input
          id="cron-expression"
          data-testid="cron-expression"
          placeholder="0 9 * * 1-5"
          class="font-mono"
          {...bind('expression')}
        />
        <p class="text-[11px] text-muted-foreground">minute hour day-of-month month day-of-week</p>
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-xs text-muted-foreground" for="cron-timezone">
          Time zone
        </label>
        <Input id="cron-timezone" data-testid="cron-timezone" {...bind('timezone')} />
      </div>
      <div class="grid grid-cols-2 gap-2">
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground" for="cron-max-iterations">
            Max runs
          </label>
          <Input
            id="cron-max-iterations"
            data-testid="cron-max-iterations"
            type="number"
            min={1}
            placeholder="Unlimited"
            {...bind('maxIterations')}
          />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-muted-foreground" for="cron-stop-after">
            Stop after
          </label>
          <Input
            id="cron-stop-after"
            data-testid="cron-stop-after"
            type="date"
            {...bind('stopAfter')}
          />
        </div>
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-xs text-muted-foreground" for="cron-max-failures">
          Pause after consecutive failures
        </label>
        <Input
          id="cron-max-failures"
          data-testid="cron-max-failures"
          type="number"
          min={1}
          placeholder="Never"
          {...bind('maxConsecutiveFailures')}
        />
      </div>
    </div>
  );
}
