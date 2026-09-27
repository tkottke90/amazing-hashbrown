import type { CronPreviewState } from '@/hooks/use-cron-preview';
import { formatFireTime } from '@/lib/cron-drafts';

// The live read-back of a schedule being edited: what it means in words and
// when it will next fire — or why it's invalid.
export function CronPreviewPanel({ state }: { state: CronPreviewState }) {
  if (state.status === 'idle') return null;
  if (state.status === 'loading') {
    return (
      <p data-testid="cron-preview" data-state="loading" class="text-xs text-muted-foreground">
        Checking schedule…
      </p>
    );
  }
  if (state.status === 'invalid' || state.status === 'error') {
    return (
      <p data-testid="cron-preview" data-state={state.status} class="text-xs text-destructive">
        {state.error}
      </p>
    );
  }
  const { description, nextFireTimes } = state.preview;
  return (
    <div
      data-testid="cron-preview"
      data-state="valid"
      class="rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs flex flex-col gap-1"
    >
      <span class="font-medium">{description}</span>
      {nextFireTimes.length > 0 ? (
        <ul class="text-muted-foreground flex flex-col">
          {nextFireTimes.map((t) => (
            <li key={t}>{formatFireTime(t)}</li>
          ))}
        </ul>
      ) : (
        <span class="text-muted-foreground">No upcoming runs.</span>
      )}
    </div>
  );
}
