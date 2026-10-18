import { z } from 'zod';
import * as widgetsLib from '@tkottke90/amazing-hashbrown-widgets';
import { WidgetNotFoundError, parseCsvBody } from '@tkottke90/amazing-hashbrown-widgets';
import { WIDGET_SIZE_MIN, WIDGET_SIZE_MAX } from '@tkottke90/amazing-hashbrown-widgets/types';
import type {
  DashboardWidget,
  WidgetContentInput,
  WidgetLoadResult,
} from '@tkottke90/amazing-hashbrown-widgets/types';
import { broadcast } from '../../services/broadcast.js';
import { getMetric, resolveSystemWidget } from '../../services/metric-registry.js';
import { getWorkspaceStore } from '../../services/workspace-store.js';
import { getUsageStore } from '../../services/usage.js';
import { env } from '../../config/env.js';
import type { MetricDeps } from '../../services/metric.js';

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
  reorderWidget: typeof widgetsLib.reorderWidget;
  peekWidgetFrontmatter: typeof widgetsLib.peekWidgetFrontmatter;
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

// Widget Size (w/h), optional on every type's input schema — present only
// on the resize handle's PATCH to this same route (updateWidgetHandler
// treats "both present" as a resize, "either absent" as preserve; see
// design spec §2.1). Clamped per type to [type minimum, WIDGET_SIZE_MAX],
// reusing the lib's shared constants rather than re-typing the numbers
// (AGENTS.md's composition-over-customization principle) — the bound
// numbers are shared, the zod call duplicating them is this file's own
// established convention.

const MarkdownWidgetInputSchema = z.object({
  type: z.literal('markdown'),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  content: z.string(),
  w: z.number().min(WIDGET_SIZE_MIN.markdown.w).max(WIDGET_SIZE_MAX.w).optional(),
  h: z.number().min(WIDGET_SIZE_MIN.markdown.h).max(WIDGET_SIZE_MAX.h).optional(),
});

const BigNumberWidgetInputSchema = z.object({
  type: z.literal('big-number'),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  value: z.number().optional(),
  unit: z.string().optional(),
  w: z.number().min(WIDGET_SIZE_MIN['big-number'].w).max(WIDGET_SIZE_MAX.w).optional(),
  h: z.number().min(WIDGET_SIZE_MIN['big-number'].h).max(WIDGET_SIZE_MAX.h).optional(),
});

const LineGraphWidgetInputSchema = z.object({
  type: z.literal('line-graph'),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  data: z.string(),
  color: HexColorSchema.optional(),
  w: z.number().min(WIDGET_SIZE_MIN['line-graph'].w).max(WIDGET_SIZE_MAX.w).optional(),
  h: z.number().min(WIDGET_SIZE_MIN['line-graph'].h).max(WIDGET_SIZE_MAX.h).optional(),
});

const PieGraphWidgetInputSchema = z.object({
  type: z.literal('pie-graph'),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  data: z.string(),
  colors: z.array(HexColorSchema).optional(),
  w: z.number().min(WIDGET_SIZE_MIN['pie-graph'].w).max(WIDGET_SIZE_MAX.w).optional(),
  h: z.number().min(WIDGET_SIZE_MIN['pie-graph'].h).max(WIDGET_SIZE_MAX.h).optional(),
});

// System widgets (ADR-0011/0013) have no Widget Payload at all — just the
// Metric id they display. Created/edited through this same route (picking
// `source: system` is what the drawer's create flow does); the metric's
// *value* is never part of this input, only which metric to show.
const SystemWidgetInputSchema = z.object({
  type: z.literal('system'),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  metric: z.string().min(1),
  w: z.number().min(WIDGET_SIZE_MIN.system.w).max(WIDGET_SIZE_MAX.w).optional(),
  h: z.number().min(WIDGET_SIZE_MIN.system.h).max(WIDGET_SIZE_MAX.h).optional(),
});

const WidgetInputSchema = z.discriminatedUnion('type', [
  MarkdownWidgetInputSchema,
  BigNumberWidgetInputSchema,
  LineGraphWidgetInputSchema,
  PieGraphWidgetInputSchema,
  SystemWidgetInputSchema,
]);

const WidgetRawSchema = z.object({
  raw: z.string(),
});

const ReorderWidgetSchema = z.object({
  targetWidgetId: z.string().min(1),
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

// Built fresh per call (not once at module load) so a settings change to
// `env.updates.checkForUpdates` takes effect on the very next dashboard
// load — no reload step, unlike TrackerRegistry.
function buildDefaultMetricDeps(): MetricDeps {
  return {
    workspaceStore: getWorkspaceStore(),
    usageStore: getUsageStore(),
    checkForUpdates: env.updates.checkForUpdates,
  };
}

export async function listWidgetsHandler(
  dashboardRoot: string,
  dashboardId: string,
  store: WidgetStoreDeps = defaultStore,
  metricDeps?: MetricDeps,
): Promise<HandlerResult<WidgetLoadResult[]>> {
  const data = await store.listWidgets(dashboardRoot, dashboardId);
  // Only touches the real stores (which throw if unbooted — fine in
  // production, fatal to a unit test that injects its own `store` and
  // never calls bootWorkspaceStore()/bootUsage()) when a system widget is
  // actually present to resolve. Most dashboards have none.
  const hasSystemWidget = data.some((r) => r.status === 'ok' && r.widget.type === 'system');
  if (!hasSystemWidget) return ok(data);

  const deps = metricDeps ?? buildDefaultMetricDeps();
  const resolved = await Promise.all(
    data.map(async (result) =>
      result.status === 'ok'
        ? { status: 'ok' as const, widget: await resolveSystemWidget(result.widget, deps) }
        : result,
    ),
  );
  return ok(resolved);
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
  if (parsed.data.type === 'system' && !getMetric(parsed.data.metric)) {
    return badRequest(`Unknown metric id "${parsed.data.metric}".`);
  }
  // Widget lifecycle (creation) is a User-only action (D10) for every type
  // except `system`, which sets `source: 'system'` instead — still created
  // through this same route (the drawer's own create flow, ADR-0013), never
  // request/tool-call input beyond the type/metric choice (ADR-0005/0011).
  // `w`/`h` are never forwarded — `createWidget` always assigns the type's
  // minimum (design spec §1.4); a caller has no form field to supply one
  // from, and `WidgetPersistInput` excludes the field entirely.
  const { w, h, ...contentFields } = parsed.data;
  void w;
  void h;
  const widget = await store.createWidget(dashboardRoot, dashboardId, {
    ...contentFields,
    source: parsed.data.type === 'system' ? 'system' : 'manual',
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
  if (parsed.data.type === 'system' && !getMetric(parsed.data.metric)) {
    return badRequest(`Unknown metric id "${parsed.data.metric}".`);
  }
  // This schema has no `maintainer` key, so without reading the existing
  // widget a full-replace write would silently drop it (D15: a manual edit
  // never clears `maintainer`). `source` always resets to 'manual' — a
  // human is doing this edit, regardless of what it was before (ADR-0005)
  // — except for `system`, which keeps `source: 'system'` (ADR-0011): a
  // title/subtitle/metric edit through this same drawer never turns a
  // system widget into a manual one.
  const existing = await store.loadWidget(dashboardRoot, dashboardId, id);
  if (!existing) return notFound(`Widget "${id}" not found.`);
  // Type is immutable after creation — no UI affordance changes it, and
  // without this check a full-replace PATCH could silently convert a
  // `system` widget into a writable one (or vice versa), undermining
  // ADR-0011's read-only guarantee.
  if (existing.type !== parsed.data.type) {
    return badRequest(
      `Widget "${id}" is type "${existing.type}" and cannot be changed to "${parsed.data.type}".`,
    );
  }
  // Widget Size: present only on the resize handle's PATCH to this route
  // (design spec §2.1) — both `w` and `h` must be present to count as a
  // resize; a lone one (which the UI never sends) is treated as absent,
  // not a partial resize. When absent, `store.updateWidget` preserves the
  // existing size itself — this handler doesn't need to know what it was.
  const { w, h, ...contentFields } = parsed.data;
  const size = w !== undefined && h !== undefined ? { w, h } : undefined;
  try {
    const widget = await store.updateWidget(
      dashboardRoot,
      dashboardId,
      id,
      {
        ...contentFields,
        source: parsed.data.type === 'system' ? 'system' : 'manual',
        maintainer: existing.maintainer,
      },
      size,
    );
    broadcast({ type: 'widget_updated', dashboardId, widget });
    return ok(widget);
  } catch (err) {
    if (err instanceof WidgetNotFoundError) return notFound(err.message);
    throw err;
  }
}

/**
 * Reorder (see GLOSSARY.md), ADR-0008: moves `id` to immediately before
 * `targetWidgetId`'s current position, splicing every widget between the
 * old and new slot. A no-op (`id === targetWidgetId`) returns an empty
 * array and broadcasts nothing — there's nothing for another open tab to
 * react to. 404 if either widget doesn't exist in this dashboard.
 */
export async function reorderWidgetHandler(
  dashboardRoot: string,
  dashboardId: string,
  id: string,
  body: unknown,
  store: WidgetStoreDeps = defaultStore,
): Promise<HandlerResult<DashboardWidget[]>> {
  const parsed = ReorderWidgetSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest(parsed.error.issues.map((i) => i.message).join('; '));
  }
  try {
    const widgets = await store.reorderWidget(
      dashboardRoot,
      dashboardId,
      id,
      parsed.data.targetWidgetId,
    );
    if (widgets.length > 0) {
      broadcast({ type: 'dashboard_reordered', dashboardId, widgets });
    }
    return ok(widgets);
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
  // A system widget's payload is never written to (ADR-0011) — not by an
  // agent, not by the CLI, which calls this same handler directly
  // in-process (api/src/agents/tools/update-widget-content.tool.ts).
  if (existing.type === 'system') {
    return badRequest(`Widget "${id}" is a system widget and cannot be written to.`);
  }

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

  // Neither direction may touch a system widget's payload (ADR-0011): not
  // the existing widget (if it's already `system`), and not the incoming
  // raw text (if it tries to declare `type: system` on what was some other
  // type — fabricating a system widget via raw paste, bypassing the
  // create-flow metric-id check entirely).
  const existingPeek = await store.peekWidgetFrontmatter(dashboardRoot, dashboardId, id);
  if (existingPeek && (existingPeek.type === 'system' || existingPeek.source === 'system')) {
    return badRequest(`Widget "${id}" is a system widget and cannot be edited as raw text.`);
  }
  // A cheap textual check, not a full YAML parse: malformed frontmatter is
  // not this guard's concern — a still-broken save just surfaces the same
  // parse error again on the next list, as today.
  if (/^\s*type:\s*system\s*$/m.test(parsed.data.raw)) {
    return badRequest('A widget cannot be converted into a system widget via raw edit.');
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
