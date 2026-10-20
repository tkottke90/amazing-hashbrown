import { signal, useComputed } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import {
  listDashboards,
  createDashboard as createDashboardApi,
  updateDashboard as updateDashboardApi,
  deleteDashboard as deleteDashboardApi,
  type DashboardListEntry,
  type DashboardUpdateInput,
} from '@/services/dashboard-api';
import { readJson, writeJson } from '@/utils/local-storage';

const ACTIVE_DASHBOARD_STORAGE_KEY = 'dashboard.activeId';

// Module-level — one app-wide dashboard list/selection, not per-component
// state, so the tab bar, the settings panel, and the dashboard page itself
// all see the same loaded list and active id (same pattern
// use-dashboard-widgets.ts already uses for its own module-level store).
const dashboards = signal<DashboardListEntry[]>([]);
const activeDashboardId = signal<string | null>(null);
const loading = signal(true);
const error = signal<string | null>(null);

function persistActiveId(id: string): void {
  writeJson(ACTIVE_DASHBOARD_STORAGE_KEY, id);
}

function resolveInitialActiveId(list: DashboardListEntry[]): string | null {
  if (list.length === 0) return null;
  const stored = readJson<string | null>(ACTIVE_DASHBOARD_STORAGE_KEY, null);
  if (stored && list.some((d) => d.id === stored)) return stored;
  return list[0]!.id;
}

async function refresh(): Promise<void> {
  try {
    const list = await listDashboards();
    dashboards.value = list;
    // Only re-resolve the active id if it's unset or no longer in the list
    // (first load, or this tab's active dashboard was deleted elsewhere) —
    // never clobber an already-valid active selection on every refresh()
    // call (e.g. one triggered by a widget save).
    if (!activeDashboardId.value || !list.some((d) => d.id === activeDashboardId.value)) {
      const next = resolveInitialActiveId(list);
      activeDashboardId.value = next;
      if (next) persistActiveId(next);
    }
    error.value = null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load dashboards';
  } finally {
    loading.value = false;
  }
}

function setActiveDashboardId(id: string): void {
  activeDashboardId.value = id;
  persistActiveId(id);
}

/** D10: immediately creates "Dashboard N", sets it active. Caller enters Edit Mode + opens the widget-add picker. */
async function createDashboard(): Promise<DashboardListEntry> {
  const name = `Dashboard ${dashboards.value.length + 1}`;
  const created = await createDashboardApi(name);
  dashboards.value = [...dashboards.value, created];
  setActiveDashboardId(created.id);
  return created;
}

async function updateDashboard(
  id: string,
  patch: DashboardUpdateInput,
): Promise<DashboardListEntry> {
  const updated = await updateDashboardApi(id, patch);
  dashboards.value = dashboards.value.map((d) => (d.id === id ? updated : d));
  return updated;
}

/** D12: deleting the active dashboard switches active to the first remaining in list order. */
async function deleteDashboard(id: string): Promise<void> {
  await deleteDashboardApi(id);
  const remaining = dashboards.value.filter((d) => d.id !== id);
  dashboards.value = remaining;
  if (activeDashboardId.value === id && remaining.length > 0) {
    setActiveDashboardId(remaining[0]!.id);
  }
}

/** Synchronous read of the current dashboard list, for callers that need a
 * name lookup without their own refresh() fetch — the dashboard page's own
 * useDashboards() call already keeps this list current. */
export function getDashboards(): DashboardListEntry[] {
  return dashboards.value;
}

// Test-only: resets module-level state between test files/cases — same
// role as _resetDashboardWidgetsForTests() in use-dashboard-widgets.ts.
export function _resetDashboardsForTests(): void {
  dashboards.value = [];
  activeDashboardId.value = null;
  loading.value = true;
  error.value = null;
}

export function useDashboards() {
  useEffect(() => {
    void refresh();
  }, []);

  return {
    dashboards: useComputed(() => dashboards.value),
    activeDashboardId: useComputed(() => activeDashboardId.value),
    loading: useComputed(() => loading.value),
    error: useComputed(() => error.value),
    setActiveDashboardId,
    createDashboard,
    updateDashboard,
    deleteDashboard,
    refresh,
  };
}
