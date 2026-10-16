import { request } from '@/utils/fetch.utils';
import type { DashboardWidget, WidgetLoadResult } from '@tkottke90/amazing-hashbrown-widgets/types';

// Only one dashboard exists so far — see the design doc's D4/D16. The UI
// never passes anything else; multi-dashboard selection is future scope.
export const DEFAULT_DASHBOARD_ID = 'default';

export interface WidgetContentInput {
  title: string;
  subtitle?: string;
  content: string;
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

export async function deleteWidget(dashboardId: string, id: string): Promise<void> {
  await fetch(
    `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/widgets/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
    },
  );
}
