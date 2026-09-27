import type { Signal } from '@preact/signals';
import { Input } from '@/components/ui/input';
import type { CronOnceDraft } from '@/lib/cron-drafts';

// Scheduled (once): a single date and time, entered in the browser's zone.
export function CronOnceFields({ draft }: { draft: Signal<CronOnceDraft> }) {
  return (
    <div class="flex flex-col gap-1" data-testid="cron-once-fields">
      <label class="text-xs text-muted-foreground" for="cron-once-fire-at">
        Run at
      </label>
      <Input
        id="cron-once-fire-at"
        type="datetime-local"
        data-testid="cron-once-fire-at"
        value={draft.value.fireAt}
        onInput={(e) => {
          draft.value = { ...draft.value, fireAt: (e.target as HTMLInputElement).value };
        }}
      />
      <p class="text-[11px] text-muted-foreground">Time zone: {draft.value.timezone}</p>
    </div>
  );
}
