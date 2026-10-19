import { request, RequestError } from '@/utils/fetch.utils';
import type {
  Dashboard,
  DashboardWidget,
  DistributiveOmit,
  ResolvedMetricValue,
  WidgetContentInput,
  WidgetLoadResult,
} from '@tkottke90/amazing-hashbrown-widgets/types';

// The original single dashboard's permanent id (see ADR-0017) — kept as the
// agent tool/CLI default; the UI resolves a real active dashboard via
// useDashboards() instead of relying on this constant for anything.
export const DEFAULT_DASHBOARD_ID = 'default';

export type { WidgetContentInput };

// ---- Dashboard Metadata (see GLOSSARY.md, ADR-0016/0017/0018) --------------------

export interface DashboardListEntry extends Dashboard {
  /** Derived, never persisted — the Settings panel's read-only folder display. */
  path: string;
}

export async function listDashboards(): Promise<DashboardListEntry[]> {
  return request<DashboardListEntry[]>('/api/v1/dashboards');
}

export async function createDashboard(name: string): Promise<DashboardListEntry> {
  return request<DashboardListEntry>('/api/v1/dashboards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export interface DashboardUpdateInput {
  name?: string;
  description?: string;
  density?: 'compact' | 'roomy';
}

export async function updateDashboard(
  id: string,
  patch: DashboardUpdateInput,
): Promise<DashboardListEntry> {
  return request<DashboardListEntry>(`/api/v1/dashboards/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function deleteDashboard(id: string): Promise<void> {
  // A 204 has no body for request() to parse (same reason tasks-api.ts's
  // deleteTask() bypasses it) — a refused delete (400, the last-dashboard
  // guard) must still surface, not vanish, so check the status here.
  const res = await fetch(`/api/v1/dashboards/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new RequestError(body.error ?? `Request failed: ${res.status}`, res.status);
  }
}

export async function fetchWidgets(dashboardId: string): Promise<WidgetLoadResult[]> {
  return request<WidgetLoadResult[]>(
    `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/widgets`,
  );
}

export async function createWidget(
  dashboardId: string,
  input: WidgetContentInput,
): Promise<DashboardWidget> {
  return request<DashboardWidget>(`/api/v1/dashboards/${encodeURIComponent(dashboardId)}/widgets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function updateWidget(
  dashboardId: string,
  id: string,
  input: WidgetContentInput,
): Promise<DashboardWidget> {
  return request<DashboardWidget>(
    `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/widgets/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

/**
 * Reorder (see GLOSSARY.md): moves `movedId` to immediately before
 * `targetId`'s current position, splicing every widget between the old and
 * new slot (ADR-0008). Returns only the widgets whose order actually
 * changed — the caller patches those directly via patchDashboardWidgets
 * rather than refetching the whole dashboard.
 */
export async function reorderWidget(
  dashboardId: string,
  movedId: string,
  targetId: string,
): Promise<DashboardWidget[]> {
  return request<DashboardWidget[]>(
    `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/widgets/${encodeURIComponent(movedId)}/reorder`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetWidgetId: targetId }),
    },
  );
}

/**
 * Widget Size (see GLOSSARY.md): PATCHes the resize handle's new `w`/`h`
 * through the same full-replace route the drawer uses, resupplying the
 * widget's current content fields so nothing else is clobbered — a
 * dedicated function (rather than widening `updateWidget`'s own type) so
 * the drawer's call path stays untouched.
 */
export async function resizeWidget(
  dashboardId: string,
  widget: DashboardWidget,
  w: number,
  h: number,
): Promise<DashboardWidget> {
  const { id, order, w: _w, h: _h, source, maintainer, updatedAt, ...contentFields } = widget;
  void id;
  void order;
  void _w;
  void _h;
  void source;
  void maintainer;
  void updatedAt;
  // `contentFields` carries a system widget's `resolved` through to the
  // PATCH body too (it's not a named field above, just whatever's left in
  // the rest-spread) — harmless: the server's SystemWidgetInputSchema has
  // no `resolved` key and silently strips it, and it's never read back.
  return request<DashboardWidget>(
    `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/widgets/${encodeURIComponent(widget.id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...contentFields, w, h }),
    },
  );
}

export async function updateWidgetRaw(dashboardId: string, id: string, raw: string): Promise<void> {
  await request(
    `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/widgets/${encodeURIComponent(id)}/raw`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    },
  );
}

/**
 * Any of the 4 widget types' fully-parsed fields — no `id` (validates
 * submitted text, not a stored resource) and no `updatedAt` (derived from a
 * file's mtime, which validating raw text never reads one of).
 */
export type ValidatedWidgetFields = DistributiveOmit<DashboardWidget, 'id' | 'updatedAt'>;

export type ValidateWidgetResult =
  { ok: true; widget: ValidatedWidgetFields } | { ok: false; error: string };

export interface ValidateWidgetInput {
  dashboardId: string;
  widgetId: string;
  raw: string;
}

// Flat, not nested under /dashboards/:dashboardId/widgets/:id/raw — this
// validates submitted text rather than a stored resource; dashboardId/
// widgetId are log-correlation context only, carried in the body.
export async function validateWidgetRaw(input: ValidateWidgetInput): Promise<ValidateWidgetResult> {
  return request<ValidateWidgetResult>('/api/v1/widgets/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

// ---- System Widget Metric catalog + preview (ADR-0013) ---------------------------
//
// Neither of these ever persists anything — the catalog is the fixed list a
// System Widget's drawer picks a `metric` id from, and the preview is a
// throwaway on-demand resolve shown before the widget is even saved.

export interface MetricCatalogEntry {
  id: string;
  label: string;
  displayType: ResolvedMetricValue['displayType'];
}

export async function fetchMetricCatalog(): Promise<MetricCatalogEntry[]> {
  return request<MetricCatalogEntry[]>('/api/v1/metrics');
}

export async function previewMetricValue(id: string): Promise<ResolvedMetricValue> {
  return request<ResolvedMetricValue>(`/api/v1/metrics/${encodeURIComponent(id)}/value`);
}

export async function deleteWidget(dashboardId: string, id: string): Promise<void> {
  await fetch(
    `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/widgets/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
    },
  );
}
