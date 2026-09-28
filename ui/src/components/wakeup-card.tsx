import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { AlarmClock } from 'lucide-preact';
import { ThreadCardShell } from './thread-card-shell';
import { CardBadge } from './card-badge';
import { Button } from '@/components/ui/button';
import { cancelWakeup, triggerWakeup, type WakeupCardPayload } from '@/services/wakeups-api';
import type { WakeupSettledBy, WakeupThreadMessage } from '@/types/thread-message';

const TICK_MS = 30_000;

// "in 14m", "in 1h 5m", "in under a minute" — coarse, refreshed every 30s.
export function formatUntil(fireAt: Date, now: Date): string {
  const minutes = Math.round((fireAt.getTime() - now.getTime()) / 60_000);
  if (minutes < 1) return 'in under a minute';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`;
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const FIRED_HOW: Partial<Record<WakeupSettledBy, string>> = {
  trigger_now: 'triggered by you',
  catch_up: 'late — the server was offline',
};

function settledText(card: WakeupCardPayload): string {
  if (card.state === 'cancelled') {
    return card.settledBy === 'agent_cancel'
      ? `Cancelled by agent${card.cancelReason ? `: ${card.cancelReason}` : ''}`
      : 'Cancelled by you';
  }
  const how = card.settledBy ? FIRED_HOW[card.settledBy] : undefined;
  const at = card.settledAt ? ` ${clockTime(card.settledAt)}` : '';
  return `Fired${at}${how ? ` (${how})` : ''}`;
}

interface WakeupCardProps {
  message: WakeupThreadMessage;
  // Needed for Cancel / Trigger now; without it the card is read-only.
  threadId?: string;
}

// A timed wake-up the agent scheduled: what it will check, when, and — while
// pending — Trigger now / Cancel. After an action the server's updated card
// is kept locally; a settled wake-up never changes again, and the next
// hydrate brings the same state. See
// docs/superpowers/specs/2026-09-27-agent-wait-design.md §7.
export function WakeupCard({ message, threadId }: WakeupCardProps) {
  const settled = useSignal<WakeupCardPayload | null>(null);
  const busy = useSignal(false);
  const error = useSignal<string | null>(null);
  const now = useSignal(new Date());

  const card: WakeupCardPayload = settled.value ?? message;
  const pending = card.state === 'pending';

  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      now.value = new Date();
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [pending]);

  async function act(action: typeof cancelWakeup) {
    if (!threadId) return;
    busy.value = true;
    error.value = null;
    try {
      settled.value = await action(threadId, card.wakeupId);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      busy.value = false;
    }
  }

  return (
    <ThreadCardShell>
      <div data-testid="wakeup-card" data-state={card.state} className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <AlarmClock className="size-3.5 shrink-0 text-muted-foreground" />
          <CardBadge variant={pending ? 'amber' : card.state === 'fired' ? 'green' : 'violet'}>
            Wake-up
          </CardBadge>
          <span data-testid="wakeup-card-status" className="text-xs text-muted-foreground">
            {pending
              ? `${formatUntil(new Date(card.fireAt), now.value)} · ${clockTime(card.fireAt)}`
              : settledText(card)}
          </span>
        </div>

        <p className="text-sm text-foreground">{card.note}</p>

        {pending && threadId && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              data-testid="wakeup-card-trigger"
              disabled={busy.value}
              onClick={() => void act(triggerWakeup)}
            >
              Trigger now
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="wakeup-card-cancel"
              disabled={busy.value}
              onClick={() => void act(cancelWakeup)}
            >
              Cancel
            </Button>
          </div>
        )}

        {error.value && (
          <p role="alert" className="text-xs text-red-600">
            {error.value}
          </p>
        )}
      </div>
    </ThreadCardShell>
  );
}
