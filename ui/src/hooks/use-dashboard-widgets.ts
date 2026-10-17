import { signal, useComputed, useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { DashboardWidget, WidgetLoadResult } from '@tkottke90/amazing-hashbrown-widgets/types';
import { fetchWidgets, DEFAULT_DASHBOARD_ID } from '@/services/dashboard-api';

// Module-level, keyed by dashboardId (future-proofs multi-dashboard #316 for
// free) — unlike every other page-local signal, this one has to be reachable
// from use-live-events.ts's widget_updated case, the same way `tasks`/
// `queueState` (use-tasks.ts) are reachable from its other cases. See
// docs/superpowers/specs/2026-10-17-dashboard-widget-write-api-design.md,
// Gap 2.
const widgetsByDashboard = signal<Record<string, WidgetLoadResult[]>>({});

function setDashboardWidgets(dashboardId: string, list: WidgetLoadResult[]): void {
  widgetsByDashboard.value = { ...widgetsByDashboard.value, [dashboardId]: list };
}

/**
 * Patches one widget in place within a dashboard's already-loaded list — a
 * no-op if that dashboard hasn't been loaded yet in this tab (nothing to
 * patch). Called from use-live-events.ts on a `widget_updated` broadcast.
 */
export function patchDashboardWidget(dashboardId: string, widget: DashboardWidget): void {
  const current = widgetsByDashboard.value[dashboardId];
  if (!current) return;
  setDashboardWidgets(
    dashboardId,
    current.map((r) =>
      r.status === 'ok' && r.widget.id === widget.id ? { status: 'ok', widget } : r,
    ),
  );
}

// Test-only: clears every dashboard's cached widgets so a fresh test file
// (or `beforeEach`) doesn't observe state left over from a previous one —
// same role as _resetThreadInstancesForTests() in use-thread.ts.
export function _resetDashboardWidgetsForTests(): void {
  widgetsByDashboard.value = {};
}

export function useDashboardWidgets(dashboardId: string = DEFAULT_DASHBOARD_ID) {
  const widgets = useComputed(() => widgetsByDashboard.value[dashboardId] ?? []);
  const loading = useSignal(true);
  const error = useSignal<string | null>(null);

  async function refresh() {
    try {
      setDashboardWidgets(dashboardId, await fetchWidgets(dashboardId));
      error.value = null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to load dashboard widgets';
    } finally {
      loading.value = false;
    }
  }

  useEffect(() => {
    void refresh();
  }, [dashboardId]);

  return { widgets, loading, error, refresh };
}
