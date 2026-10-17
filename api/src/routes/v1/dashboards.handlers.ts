import { z } from 'zod';
import * as widgetsLib from '@tkottke90/amazing-hashbrown-widgets';
import { WidgetNotFoundError, parseCsvBody } from '@tkottke90/amazing-hashbrown-widgets';
import type {
  DashboardWidget,
  WidgetContentInput,
  WidgetLoadResult,
} from '@tkottke90/amazing-hashbrown-widgets/types';
import { broadcast } from '../../services/broadcast.js';

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
  loadWidget: typeof widgetsLib.loadWidget;
  createWidget: typeof widgetsLib.createWidget;
  updateWidget: typeof widgetsLib.updateWidget;
  updateWidgetRaw: typeof widgetsLib.updateWidgetRaw;
  deleteWidget: typeof widgetsLib.deleteWidget;
}

const defaultStore: WidgetStoreDeps = widgetsLib;

// ---- Validation -----------------------------------------------------------------
//
// One schema per widget type, combined into a discriminated union on `type`
// — mirrors the shape of `WidgetContentInput`/the lib's own frontmatter
// schemas, minus `order` (server-assigned, never client-supplied). A hex
// regex is duplicated here rather than imported from the lib's `internal/`
// module, consistent with this file already hand-authoring its own request
// schema independent of the lib's persistence-layer schema.

const HexColorSchema = z
  .string()
  .regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i, 'Expected a hex color (#rgb or #rrggbb)');

const MarkdownWidgetInputSchema = z.object({
  type: z.literal('markdown'),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  content: z.string(),
});

const BigNumberWidgetInputSchema = z.object({
  type: z.literal('big-number'),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  value: z.number().optional(),
  unit: z.string().optional(),
});

const LineGraphWidgetInputSchema = z.object({
  type: z.literal('line-graph'),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  data: z.string(),
  color: HexColorSchema.optional(),
});

const PieGraphWidgetInputSchema = z.object({
  type: z.literal('pie-graph'),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  data: z.string(),
  colors: z.array(HexColorSchema).optional(),
});

const WidgetInputSchema = z.discriminatedUnion('type', [
  MarkdownWidgetInputSchema,
  BigNumberWidgetInputSchema,
  LineGraphWidgetInputSchema,
  PieGraphWidgetInputSchema,
]);

const WidgetRawSchema = z.object({
  raw: z.string(),
});

// ---- Content-only input (D4) ------------------------------------------------------
//
// One schema per widget type for the Agent/CLI content-merge route — only
// Widget Payload fields plus an optional `maintainer`. No `title`/
// `subtitle`/`order` key exists on any of these: supplying one is a
// validation error (extra keys are stripped by a bare z.object(), not
// rejected — but none of these fields ever reach `buildWidget`/persistence
// since the handler only reads the keys each schema actually declares).
// Never a `type` key either — a widget's type is read from the stored
// widget, never accepted as input (D5).

const MarkdownContentInputSchema = z.object({
  content: z.string().optional(),
  maintainer: z.string().optional(),
});

const BigNumberContentInputSchema = z.object({
  value: z.number().optional(),
  unit: z.string().optional(),
  maintainer: z.string().optional(),
});

const LineGraphContentInputSchema = z.object({
  data: z.string().optional(),
  color: HexColorSchema.optional(),
  maintainer: z.string().optional(),
});

const PieGraphContentInputSchema = z.object({
  data: z.string().optional(),
  colors: z.array(HexColorSchema).optional(),
  maintainer: z.string().optional(),
});

const CONTENT_INPUT_SCHEMAS = {
  markdown: MarkdownContentInputSchema,
  'big-number': BigNumberContentInputSchema,
  'line-graph': LineGraphContentInputSchema,
  'pie-graph': PieGraphContentInputSchema,
} as const;

/**
 * The structural Zod schemas above only check `data: z.string()` for
 * Line/Pie Graph — any string passes, including malformed CSV. CSV Body
 * shape (header row, ≥1 row, numeric values) and Pie's non-negative rule
 * (D5/D7) are checked here, reusing the lib's `parseCsvBody` — the same
 * function `parseWidgetFile` uses when reading a file back, so a create/
 * update and a later load can never disagree about what counts as valid.
 * Also called by `updateWidgetContentHandler` against a full merged
 * `DashboardWidget`, not just a fresh `WidgetContentInput` — it only ever
 * reads `.type`/`.data`, so either shape works.
 */
function validateTypeSpecificPayload(input: WidgetContentInput | DashboardWidget): string | null {
  if (input.type !== 'line-graph' && input.type !== 'pie-graph') return null;
  const csv = parseCsvBody(input.data);
  if (!csv.ok) return csv.error;
  if (input.type === 'pie-graph' && csv.data.values.some((value) => value < 0)) {
    return 'Pie Graph values must be non-negative.';
  }
  return null;
}

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
  const parsed = WidgetInputSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const payloadError = validateTypeSpecificPayload(parsed.data);
  if (payloadError) return badRequest(payloadError);
  // Widget lifecycle (creation) is a User-only action (D10) — always
  // 'manual', nothing to preserve, and never request/tool-call input (ADR-0005).
  const widget = await store.createWidget(dashboardRoot, dashboardId, {
    ...parsed.data,
    source: 'manual',
  });
  broadcast({ type: 'widget_updated', dashboardId, widget });
  return ok(widget);
}

export async function updateWidgetHandler(
  dashboardRoot: string,
  dashboardId: string,
  id: string,
  body: unknown,
  store: WidgetStoreDeps = defaultStore,
): Promise<HandlerResult<DashboardWidget>> {
  const parsed = WidgetInputSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const payloadError = validateTypeSpecificPayload(parsed.data);
  if (payloadError) return badRequest(payloadError);
  // This schema has no `maintainer` key, so without reading the existing
  // widget a full-replace write would silently drop it (D15: a manual edit
  // never clears `maintainer`). `source` always resets to 'manual' — a
  // human is doing this edit, regardless of what it was before (ADR-0005).
  const existing = await store.loadWidget(dashboardRoot, dashboardId, id);
  if (!existing) return notFound(`Widget "${id}" not found.`);
  try {
    const widget = await store.updateWidget(dashboardRoot, dashboardId, id, {
      ...parsed.data,
      source: 'manual',
      maintainer: existing.maintainer,
    });
    broadcast({ type: 'widget_updated', dashboardId, widget });
    return ok(widget);
  } catch (err) {
    if (err instanceof WidgetNotFoundError) return notFound(err.message);
    throw err;
  }
}

/**
 * Agent/CLI content-merge write (D2/ADR-0004): loads the existing widget,
 * overlays only the fields actually present in `body` plus an optional
 * `maintainer`, re-validates the merged whole against the existing per-type
 * schema, persists, and broadcasts. `type` is read from the stored widget
 * and never accepted as input — a widget's type is immutable (same rule as
 * `id`). `source` is always whatever the caller (the route, or the agent
 * tool calling this directly) passes in — never the request body
 * (ADR-0005); today that's always `'agent'`.
 */
export async function updateWidgetContentHandler(
  dashboardRoot: string,
  dashboardId: string,
  id: string,
  body: unknown,
  source: 'agent',
  store: WidgetStoreDeps = defaultStore,
): Promise<HandlerResult<DashboardWidget>> {
  const existing = await store.loadWidget(dashboardRoot, dashboardId, id);
  if (!existing) return notFound(`Widget "${id}" not found.`);

  const parsed = CONTENT_INPUT_SCHEMAS[existing.type].safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join('; '));
  }

  const merged = { ...existing, ...parsed.data, source } as DashboardWidget;
  const payloadError = validateTypeSpecificPayload(merged);
  if (payloadError) return badRequest(payloadError);

  const widget = await store.updateWidget(dashboardRoot, dashboardId, id, merged);
  broadcast({ type: 'widget_updated', dashboardId, widget });
  return ok(widget);
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
