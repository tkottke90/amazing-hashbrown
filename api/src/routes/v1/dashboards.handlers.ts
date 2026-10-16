import { z } from 'zod';
import * as widgetsLib from '@tkottke90/amazing-hashbrown-widgets';
import { WidgetNotFoundError } from '@tkottke90/amazing-hashbrown-widgets';
import type { DashboardWidget, WidgetLoadResult } from '@tkottke90/amazing-hashbrown-widgets/types';

// ---- HandlerResult (mirrors mcp-servers.handlers.ts) ---------------------------

export interface HandlerFailure {
  ok: false;
  status: 400 | 404;
  error: string;
}

export type HandlerResult<T> = { ok: true; data: T } | HandlerFailure;

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function notFound(error: string): HandlerFailure {
  return { ok: false, status: 404, error };
}

function badRequest(error: string): HandlerFailure {
  return { ok: false, status: 400, error };
}

// ---- Store dependency (injectable for tests — see api/AGENTS.md's testing section) ----

export interface WidgetStoreDeps {
  listWidgets: typeof widgetsLib.listWidgets;
  createWidget: typeof widgetsLib.createWidget;
  updateWidget: typeof widgetsLib.updateWidget;
  updateWidgetRaw: typeof widgetsLib.updateWidgetRaw;
  deleteWidget: typeof widgetsLib.deleteWidget;
}

const defaultStore: WidgetStoreDeps = widgetsLib;

// ---- Validation ----------------------------------------------------------------

const WidgetContentSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  content: z.string(),
});

const WidgetRawSchema = z.object({
  raw: z.string(),
});

// ---- Handlers --------------------------------------------------------------------

export async function listWidgetsHandler(
  dashboardRoot: string,
  dashboardId: string,
  store: WidgetStoreDeps = defaultStore,
): Promise<HandlerResult<WidgetLoadResult[]>> {
  const data = await store.listWidgets(dashboardRoot, dashboardId);
  return ok(data);
}

export async function createWidgetHandler(
  dashboardRoot: string,
  dashboardId: string,
  body: unknown,
  store: WidgetStoreDeps = defaultStore,
): Promise<HandlerResult<DashboardWidget>> {
  const parsed = WidgetContentSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const widget = await store.createWidget(dashboardRoot, dashboardId, parsed.data);
  return ok(widget);
}

export async function updateWidgetHandler(
  dashboardRoot: string,
  dashboardId: string,
  id: string,
  body: unknown,
  store: WidgetStoreDeps = defaultStore,
): Promise<HandlerResult<DashboardWidget>> {
  const parsed = WidgetContentSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join('; '));
  }
  try {
    const widget = await store.updateWidget(dashboardRoot, dashboardId, id, parsed.data);
    return ok(widget);
  } catch (err) {
    if (err instanceof WidgetNotFoundError) return notFound(err.message);
    throw err;
  }
}

/**
 * Unconditional raw-content overwrite — the remediation path for a widget
 * whose frontmatter failed to parse. No content validation: a still-broken
 * save just surfaces the same error again on the next list.
 */
export async function updateWidgetRawHandler(
  dashboardRoot: string,
  dashboardId: string,
  id: string,
  body: unknown,
  store: WidgetStoreDeps = defaultStore,
): Promise<HandlerResult<{ updated: true }>> {
  const parsed = WidgetRawSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join('; '));
  }
  try {
    await store.updateWidgetRaw(dashboardRoot, dashboardId, id, parsed.data.raw);
    return ok({ updated: true });
  } catch (err) {
    if (err instanceof WidgetNotFoundError) return notFound(err.message);
    throw err;
  }
}

export async function deleteWidgetHandler(
  dashboardRoot: string,
  dashboardId: string,
  id: string,
  store: WidgetStoreDeps = defaultStore,
): Promise<HandlerResult<{ deleted: true }>> {
  try {
    await store.deleteWidget(dashboardRoot, dashboardId, id);
    return ok({ deleted: true });
  } catch (err) {
    if (err instanceof WidgetNotFoundError) return notFound(err.message);
    throw err;
  }
}
