import { AlarmClock } from 'lucide-preact';
import type { WakeupFiredThreadMessage } from '@/types/thread-message';

interface WakeupFiredMarkerProps {
  message: WakeupFiredThreadMessage;
}

// Divider directly above the turn a wake-up resumed, so the agent's reply
// is visibly a response to its own wake-up rather than to nothing.
export function WakeupFiredMarker({ message }: WakeupFiredMarkerProps) {
  const early = message.settledBy === 'trigger_now';
  return (
    <div
      data-testid="wakeup-fired-marker"
      className="flex items-center gap-2 py-1 text-xs text-muted-foreground"
    >
      <AlarmClock className="size-3.5 shrink-0" />
      <span>
        {early ? 'Woke up early (triggered by you): ' : 'Woke up: '}
        <span className="font-medium text-foreground">{message.note}</span>
      </span>
    </div>
  );
}
