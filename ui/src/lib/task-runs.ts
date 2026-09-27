import type { TriggerSource } from '@/services/tasks-api';

// Shared wording for "what started this run", so the run view header, the
// run markers in chat and the drawer's run history all say the same thing.
const TRIGGER_SOURCE_LABEL: Record<TriggerSource, string> = {
  manual: 'Manual',
  webhook: 'Webhook',
  schedule: 'Scheduled',
  catch_up: 'Catch-up',
  chat: 'From chat',
  agent: 'Sub-agent',
};

export function triggerSourceLabel(source: TriggerSource | undefined): string {
  return source ? TRIGGER_SOURCE_LABEL[source] : 'Manual';
}

// "Scheduled run #12" / "Run #3" — the name a run goes by everywhere.
export function runName(runNumber: number, source?: TriggerSource): string {
  return source === 'schedule' || source === 'catch_up'
    ? `Scheduled run #${runNumber}`
    : `Run #${runNumber}`;
}

// The read-only run view lives at the normal chat route (see ChatRoot).
export function runPath(runThreadId: string): string {
  return `/chat/${runThreadId}`;
}
