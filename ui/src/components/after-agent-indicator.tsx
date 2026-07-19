import { useEffect, useRef } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { Loader2, Check, AlertTriangle } from 'lucide-preact';

import { cn } from '@/lib/utils';
import type { AfterAgentState } from '@/hooks/use-thread';

// How long a "done" outcome stays visible before the indicator reverts to
// idle (nothing rendered) — independent of the server's own DONE_TTL_MS
// (which just gives a slow poller headroom to catch it at all). We only need
// to show it once per completion, not for as long as the server remembers it.
const FLASH_MS = 2500;

// Holds a "done" state on screen for FLASH_MS after it's first observed, then
// reports idle regardless of what later polls still say — dedups on
// finishedAt so repeated polls of the same completion don't re-arm the timer.
function useAfterAgentFlash(state: AfterAgentState): AfterAgentState {
  const held = useSignal<AfterAgentState>(state);
  const flashingKey = useRef<string | null>(null);

  useEffect(() => {
    if (state.status !== 'done') {
      flashingKey.current = null;
      held.value = state;
      return;
    }

    if (flashingKey.current === state.finishedAt) return; // already flashing this completion
    flashingKey.current = state.finishedAt;
    held.value = state;

    const timer = setTimeout(() => {
      held.value = { status: 'idle' };
    }, FLASH_MS);
    return () => clearTimeout(timer);
  }, [state.status, state.status === 'done' ? state.finishedAt : undefined]);

  return held.value;
}

const OUTCOME_LABEL: Record<'identified' | 'no-op' | 'error', string> = {
  identified: 'Added to knowledge base',
  'no-op': 'Nothing new to save',
  error: 'Background task failed',
};

interface AfterAgentIndicatorProps {
  state: AfterAgentState;
  showLabel?: boolean;
  className?: string;
}

export function AfterAgentIndicator({ state, showLabel, className }: AfterAgentIndicatorProps) {
  const display = useAfterAgentFlash(state);

  if (display.status === 'idle') return null;

  if (display.status === 'running') {
    return (
      <span className={cn('inline-flex items-center gap-1.5 text-muted-foreground', className)}>
        <Loader2 className="size-4 shrink-0 animate-spin" />
        {showLabel && <span className="text-xs">Working in the background…</span>}
      </span>
    );
  }

  const Icon = display.outcome === 'error' ? AlertTriangle : Check;
  const colorClass =
    display.outcome === 'error'
      ? 'text-destructive'
      : display.outcome === 'identified'
        ? 'text-success'
        : 'text-muted-foreground';

  return (
    <span className={cn('inline-flex items-center gap-1.5', colorClass, className)}>
      <Icon className="size-4 shrink-0" strokeWidth={display.outcome === 'error' ? 2 : 2.5} />
      {showLabel && <span className="text-xs">{OUTCOME_LABEL[display.outcome]}</span>}
    </span>
  );
}
