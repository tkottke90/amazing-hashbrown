import { Fragment } from 'preact';
import { useEffect } from 'preact/hooks';
import { useComputed, useSignal } from '@preact/signals';
import type { ProviderActivitySnapshot } from '@tkottke90/llm-common-types/chat';
import { providers, defaultProviderName, fetchProviders } from '@/hooks/use-providers';
import { providerActivityState, fetchProviderActivity } from '@/hooks/use-provider-activity';
import { queueState } from '@/hooks/use-tasks';
import { cn } from '@/lib/utils';
import type { Task } from '@/services/tasks-api';
import { buildGreenRoomLanes, type GreenRoomEntry } from './green-room';
import { repinTask } from './provider-repin';

type Status = 'idle' | 'healthy' | 'busy' | 'full';

// Mirrors the locked prototype's severity rule: full when every seat is
// taken AND someone is on the Provider Line, busy when full but no one's
// waiting, healthy when some seats are free and occupied, idle when empty.
function statusOf(snapshot: ProviderActivitySnapshot | undefined): Status {
  if (!snapshot || snapshot.active.length === 0) return 'idle';
  if (snapshot.maxConcurrency > 0 && snapshot.active.length >= snapshot.maxConcurrency) {
    return snapshot.waiting.length > 0 ? 'full' : 'busy';
  }
  return 'healthy';
}

const STATUS_DOT: Record<Status, string> = {
  idle: 'bg-muted-foreground/30',
  healthy: 'bg-emerald-500',
  busy: 'bg-amber-500',
  full: 'bg-red-500',
};
const STATUS_TEXT: Record<Status, string> = {
  idle: 'text-muted-foreground',
  healthy: 'text-emerald-600 dark:text-emerald-400',
  busy: 'text-amber-600 dark:text-amber-400',
  full: 'text-red-600 dark:text-red-400',
};
const STATUS_LABEL: Record<Status, string> = {
  idle: 'Idle',
  healthy: 'Healthy',
  busy: 'Busy',
  full: 'Full',
};

// A provider bar's thickness is a stable layout property (maxConcurrency),
// not something that changes as slots fill — only the dots inside it do.
function barHeight(maxConcurrency: number): number {
  return Math.max(44, 28 + Math.max(0, maxConcurrency) * 16);
}

function GreenRoomChip({
  entry,
  onDragStart,
}: {
  entry: GreenRoomEntry;
  onDragStart: (e: PointerEvent, task: Task) => void;
}) {
  if (entry.source === 'ready') {
    return (
      <button
        type="button"
        data-testid="green-room-chip-ready"
        class="text-left text-[11px] font-mono truncate rounded border border-primary/40 bg-primary/5 px-1.5 py-0.5 cursor-grab active:cursor-grabbing hover:border-primary transition-colors"
        title={`${entry.label} — drag onto a provider to re-pin`}
        onPointerDown={(e) => onDragStart(e, entry.task)}
      >
        {entry.label}
      </button>
    );
  }
  return (
    <span
      data-testid="green-room-chip-live"
      class="text-[11px] font-mono truncate rounded border border-border bg-muted/40 px-1.5 py-0.5 text-muted-foreground"
      title={`${entry.label} — running, can't be re-pinned`}
    >
      {entry.label}
    </span>
  );
}

// The Provider Activity Monitor's Room view (GLOSSARY.md § Monitoring) —
// Green Room (30%) and Provider bars (70%), live via providerActivityState
// (provider_activity_update broadcast) with no polling. Plain flex/grid, not
// SVG+D3 — see docs/superpowers/specs/2026-11-16-monitoring-task-queue-provider-activity-design.md
// and the implementation plan's group 7.
export function ProviderActivityMonitor() {
  useEffect(() => {
    void fetchProviders();
    void fetchProviderActivity();
  }, []);

  const dragging = useSignal<{ task: Task; x: number; y: number } | null>(null);

  function onDragStart(e: PointerEvent, task: Task) {
    e.preventDefault();
    dragging.value = { task, x: e.clientX, y: e.clientY };

    function onMove(ev: PointerEvent) {
      if (!dragging.value) return;
      dragging.value = { ...dragging.value, x: ev.clientX, y: ev.clientY };
    }
    function onUp(ev: PointerEvent) {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const elementAtPoint = document.elementFromPoint(ev.clientX, ev.clientY);
      const dropTarget = (elementAtPoint as HTMLElement | null)?.closest<HTMLElement>(
        '[data-provider-bar]',
      );
      const targetProvider = dropTarget?.dataset.providerBar;
      dragging.value = null;
      if (targetProvider && targetProvider !== task.provider) {
        void repinTask(task, targetProvider);
      }
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  const lanes = useComputed(() =>
    buildGreenRoomLanes(providerActivityState.value, queueState.value, defaultProviderName.value),
  );

  return (
    <section class="mb-9">
      <div class="mb-3">
        <h2 class="text-base font-semibold">Provider Activity</h2>
        <p class="text-xs text-muted-foreground mt-0.5">
          Who's holding or waiting on each provider's concurrency limit, live — drag a queued
          task's chip onto another provider to re-pin it.
        </p>
      </div>

      {providers.value.length === 0 ? (
        <div class="border border-border rounded-xl py-10 text-center text-sm text-muted-foreground">
          No providers configured.
        </div>
      ) : (
        <div class="grid grid-cols-[30%_1fr] gap-x-4 gap-y-3">
          <div class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground px-1">
            Green Room
          </div>
          <div class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground px-1">
            Providers
          </div>
          {providers.value.map((p) => {
            const snapshot = providerActivityState.value.find((s) => s.provider === p.name);
            const lane = lanes.value.get(p.name) ?? [];
            const status = statusOf(snapshot);
            const height = barHeight(p.maxConcurrency);
            const activeCount = snapshot?.active.length ?? 0;
            const freeCount = Math.max(0, p.maxConcurrency - activeCount);

            return (
              <Fragment key={p.name}>
                <div
                  data-testid="green-room-lane"
                  data-provider={p.name}
                  class="border border-dashed border-border rounded-lg bg-muted/20 p-1.5 flex flex-col gap-1 justify-center"
                  style={{ minHeight: `${height}px` }}
                >
                  {lane.length === 0 ? (
                    <span class="text-[10px] text-muted-foreground/60 text-center">—</span>
                  ) : (
                    lane.map((entry) => (
                      <GreenRoomChip key={entry.key} entry={entry} onDragStart={onDragStart} />
                    ))
                  )}
                </div>

                <div
                  data-testid="provider-bar"
                  data-provider-bar={p.name}
                  class="border border-border rounded-lg px-3 py-2 flex flex-col gap-1.5 justify-center"
                  style={{ minHeight: `${height}px` }}
                >
                  <div class="flex items-center justify-between">
                    <span class="text-sm font-mono font-medium">{p.name}</span>
                    <span
                      class={cn(
                        'text-[10px] font-medium uppercase tracking-wide',
                        STATUS_TEXT[status],
                      )}
                    >
                      {STATUS_LABEL[status]}
                    </span>
                  </div>
                  <div class="flex items-center gap-1 flex-wrap">
                    {snapshot?.active.map((caller) => (
                      <span
                        key={caller.threadId}
                        class={cn('size-2.5 rounded-full', STATUS_DOT[status])}
                        title={caller.label}
                      />
                    ))}
                    {Array.from({ length: freeCount }).map((_, i) => (
                      <span
                        key={`free-${i}`}
                        class="size-2.5 rounded-full border border-border"
                        title="Free"
                      />
                    ))}
                  </div>
                  <span class="text-[10px] text-muted-foreground font-mono">
                    {activeCount}/{p.maxConcurrency > 0 ? p.maxConcurrency : '∞'}
                  </span>
                </div>
              </Fragment>
            );
          })}
        </div>
      )}

      {dragging.value && (
        <div
          class="fixed z-50 pointer-events-none rounded-full border border-primary bg-background px-2 py-1 text-xs font-mono shadow-lg"
          style={{ left: `${dragging.value.x + 10}px`, top: `${dragging.value.y + 10}px` }}
        >
          {dragging.value.task.title}
        </div>
      )}
    </section>
  );
}
