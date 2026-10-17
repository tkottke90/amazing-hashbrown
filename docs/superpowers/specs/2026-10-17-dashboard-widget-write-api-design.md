# Dashboard Widget System — Agent/CLI Widget Write API — Design

**Date:** 2026-10-17
**Status:** Draft
**Related:** [Issue #315](https://github.com/tkottke90/amazing-hashbrown/issues/315) (this issue), [Issue #176](https://github.com/tkottke90/amazing-hashbrown/issues/176) (overall vision), [Issue #313](https://github.com/tkottke90/amazing-hashbrown/issues/313) (per-type validation schemas, already shipped via PR #318 — this issue no longer depends on it being incremental), [Issue #320](https://github.com/tkottke90/amazing-hashbrown/issues/320) (System-provided telemetry widgets, split out of this design, not this issue). Terminology used throughout (Widget, Dashboard, Widget Frontmatter, Widget Body, CSV Body, Color Override, **Widget Payload**, **Widget Metadata**, **Widget Source**, **Widget Maintainer**) is defined in [`GLOSSARY.md`](../../../GLOSSARY.md). [ADR-0003](../../adr/0003-reserve-system-widget-source-with-no-producer.md), [ADR-0004](../../adr/0004-two-widget-write-paths.md), [ADR-0005](../../adr/0005-widget-source-set-by-caller-not-input.md), and [ADR-0006](../../adr/0006-widget-updated-at-from-file-mtime.md) record the decisions below that are hard to reverse.

---

## Goal

Let an agent (a conversational tool call) or a CLI-driven automation script update an existing widget's Widget Payload, scoped to one widget by id, validated the same way the UI drawer already is — without needing to know or resupply that widget's Widget Metadata. A dashboard already open in a browser reflects such a write live, over the existing SSE channel. Every write records, programmatically and non-overridably, which of the three surfaces made it.

## Problem

The only existing write path (`PATCH /api/v1/dashboards/:dashboardId/widgets/:id`) requires the complete widget payload — including `title` — on every call, because it was built for the UI drawer, which always has the full form in hand. An automation that only knows "the new value is 42.17" has no such form; forcing it to resupply a title it doesn't know (or risk overwriting with the wrong one) is the exact UX problem this issue exists to fix. Separately, nothing today records *who* last changed a widget, and the dashboard has no live-refresh path for a write that didn't originate from the browser tab currently looking at it.

---

## Decisions (and why)

| #   | Decision | Rationale |
| --- | --- | --- |
| D1  | All four widget types (Markdown, Big Number, Line Graph, Pie Graph) are supported from day one. | #313 already shipped real per-type Zod schemas for all four (PR #318) — the "Markdown first, land incrementally" framing in #315's original dev notes no longer applies. |
| D2  | Two write paths, not one endpoint serving two schemas: the existing drawer route stays a full replace; a new sibling route does a partial Widget Payload merge. | See [ADR-0004](../../adr/0004-two-widget-write-paths.md). |
| D3  | The new route is `PATCH /api/v1/dashboards/:dashboardId/widgets/:id/content`, mirroring the existing `.../widgets/:id/raw` sibling. | Same resource, a different write mode — the established pattern this codebase already uses for `updateWidgetRawHandler`. |
| D4  | The new route's input schema is per-type Widget Payload fields plus optional `maintainer` — it has no `title`/`subtitle`/`order` keys at all; supplying them is a validation error, not a silently-dropped no-op. | Makes the Widget Metadata/Widget Payload boundary explicit rather than implicit — see GLOSSARY.md. |
| D5  | The handler loads the stored widget, overlays only the fields actually present in the request body, re-validates the full merged object against the existing per-type schema, then persists. `type` is read from the stored widget and is never accepted as input (immutable, same rule as `id`). | Lets a caller send `{ value: 42.5 }` alone; everything else keeps its current stored value. Re-validating the merged whole (not just the delta) catches any resulting inconsistency the same way `createWidgetHandler` already does. |
| D6  | The agent tool calls this route's handler function directly, in-process. The CLI calls the same route over `http://localhost:<port>`. | The agent runs in the API server's own process (same convention as every other `agents/tools/*.tool.ts` calling into `*.handlers.ts`); the CLI is a separate OS process with no access to that in-process state, so it must go over HTTP — per #315's own recommendation. |
| D7  | No new auth is introduced for either route. | No v1 route has auth/localhost-only middleware today; this is a single-user local app, and the CLI's localhost-HTTP design depends on that staying true. |
| D8  | The agent tool is static and always bound, like `create_tasks` — not registered in `GATED_SKILL_REGISTRATIONS`. | The issue frames this as something an agent does as part of an ordinary conversation turn, not one specific skill flow. |
| D9  | Both the tool and the CLI take an optional `dashboardId`, defaulting to `'default'`. | Only one hardcoded dashboard exists today (#316 is the future multi-dashboard work); defaulting now avoids a breaking argument-shape change later. |
| D10 | Widget creation and deletion stay User/UI-drawer-only. Neither the agent tool nor the CLI can create or delete a widget. | Widget lifecycle is an intentional, human action; only Widget Payload content is ever written by a non-human surface. Also matches #315's own "Expected Behavior," which only ever describes updating an existing widget by id. |
| D11 | `Widget Source` is `'manual' \| 'agent' \| 'system'`, set by the calling code only — never by the request body or the agent tool's own arguments. The drawer route hardcodes `'manual'`; the new content route (and therefore both the agent tool and the CLI) hardcodes `'agent'`. | See [ADR-0005](../../adr/0005-widget-source-set-by-caller-not-input.md). CLI-driven automation and a conversational tool call are both `'agent'` — there is no separate "automation" value. |
| D12 | `'system'` is reserved in the type now but has no selector, no producer, and no UI option anywhere in this issue. | See [ADR-0003](../../adr/0003-reserve-system-widget-source-with-no-producer.md). Tracked as its own feature in #320. |
| D13 | A widget whose file predates `source` reads as `'manual'` — no migration script. | The frontmatter schemas aren't strict; an old file simply parses with the field absent, filled to `'manual'` at read time (a reasonable assumption — every pre-feature widget actually was drawer-created). The very next agent/CLI write naturally advances it to `'agent'`. |
| D14 | `updatedAt` is derived from the widget file's own `mtime` at list/load time — never a persisted frontmatter field. | See [ADR-0006](../../adr/0006-widget-updated-at-from-file-mtime.md). |
| D15 | `Widget Maintainer` is an optional free-text field, accepted only by the new content route's schema (never the drawer's), preserved across any write that doesn't resupply it, and never auto-cleared by a drawer edit. | Lets an automation self-identify ("which script is keeping this widget current") without that identity being erasable by an unrelated metadata edit. |
| D16 | A new `AppBroadcastEvent` variant, `widget_updated`, carries `{ dashboardId, widget: <full updated DashboardWidget> }`. Broadcast from both the drawer route and the new content route. | Follows the existing "full current value" precedent (`task_queue_update`, `after_agent_state`) so the UI patches in place with no extra round-trip; broadcasting from both routes means *any* write refreshes an open dashboard, regardless of which surface made it, per #315's own dev notes. |
| D17 | The widget card renders the Widget Source + Widget Maintainer as a badge ("Manual" / "Agent" / "Agent · \<maintainer\>") and the mtime-derived relative "updated Xm ago" footer now, not deferred to a follow-up. | Scope correction from an earlier draft of this design — capturing the data without ever surfacing it would leave #315 only half-delivering the #176 mockup's intent. |
| D18 | The CLI is one new ad-hoc `tsx` script, `bin/widget-update.ts`, with no new CLI framework (no commander/yargs, no `package.json` `bin` entry) — `node:util parseArgs`, same as every existing `bin/*.ts` script. It takes `--dashboard-id` (optional), `--id`, and a single `--data '<json>'` payload flag — not one flag per possible field. | Matches this repo's existing `bin/` convention exactly; a single JSON flag covers all four widget types' differing field shapes without four times the flag-parsing code, and is what a script-generated caller (Ansible, a cron job) constructs anyway. |

---

## 1. Types (`lib/amazing-hashbrown-widgets/src/types.ts`)

```ts
export interface WidgetBase {
  id: string;
  type: string;
  title: string;
  subtitle?: string;
  order: number;
  /** Widget Source — see GLOSSARY.md. */
  source: 'manual' | 'agent' | 'system';
  /** Widget Maintainer — see GLOSSARY.md. Only ever set via the content route. */
  maintainer?: string;
  /** Derived from the widget file's mtime (ADR-0006) — never persisted. ISO 8601. */
  updatedAt: string;
}
```

`WidgetLoadResult`'s `ok` branch carries the same enriched `DashboardWidget`; the `error` branch is unaffected.

## 2. Frontmatter (`lib/amazing-hashbrown-widgets/src/internal/frontmatter.ts`)

Each per-type `*WidgetFrontmatterSchema` gains:

```ts
source: z.enum(['manual', 'agent', 'system']).optional().default('manual'),
maintainer: z.string().optional(),
```

`parseWidgetFile` additionally stats the file and attaches `updatedAt: stat.mtime.toISOString()` to the parsed result — this does not touch `ParsedWidgetFile`'s `data`/`body` split, since `updatedAt` never lives in frontmatter.

## 3. Store (`lib/amazing-hashbrown-widgets/src/store.ts`)

`createWidget`/`updateWidget` stay dumb persistence: they write exactly the full `DashboardWidget`-shaped object they're handed, including whatever `source`/`maintainer` the caller already computed. Neither function special-cases a source value itself — that logic belongs to the handler layer (section 5), so the same store functions stay correct for both the drawer's and the new content route's callers.

New: `loadWidget(root, dashboardId, id): Promise<DashboardWidget | null>` — the single-widget counterpart to `listWidgets`, used by the new content handler (which needs one widget's current state, not the whole list).

## 4. New content route (`api/src/routes/v1/dashboards.route.ts` / `dashboards.handlers.ts`)

```ts
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

  const merged: DashboardWidget = { ...existing, ...parsed.data, source };
  const payloadError = validateTypeSpecificPayload(merged);
  if (payloadError) return badRequest(payloadError);

  const widget = await store.updateWidget(dashboardRoot, dashboardId, id, merged);
  broadcast({ type: 'widget_updated', dashboardId, widget });
  return ok(widget);
}
```

`PATCH /:dashboardId/widgets/:id/content` in `dashboards.route.ts` parses params and calls this with `source: 'agent'` hardcoded in the route, same as the agent tool does when calling it directly.

## 5. Drawer route changes (existing `updateWidgetHandler`/`createWidgetHandler`)

Both now call `broadcast({ type: 'widget_updated', dashboardId, widget })` after a successful write.

`createWidgetHandler` builds its object with `source: 'manual'`, `maintainer: undefined` — there's nothing prior to preserve.

`updateWidgetHandler` now also loads the existing widget first (via the new `loadWidget`) purely to read its current `maintainer` — its own `WidgetInputSchema` still has no `maintainer` key, so without this read a full-replace write would silently drop it. It then calls `store.updateWidget` with `{ ...input, source: 'manual', maintainer: existing.maintainer }`: `title`/`subtitle`/Widget Payload come from the full request body as today (unchanged full-replace behavior), `source` is always reset to `'manual'` (a human is doing this edit, regardless of what it was before), and `maintainer` is carried forward untouched — satisfying D15's "a manual edit never clears `maintainer`."

## 6. Broadcast event (`lib/llm-common-types/src/chat/broadcast-events.ts`)

```ts
const WidgetUpdatedSchema = z.object({
  type: z.literal('widget_updated'),
  dashboardId: z.string(),
  widget: DashboardWidgetSchema, // the lib's own schema, re-exported for this union member
});
```

Added as a new branch of `AppBroadcastEvent`'s discriminated union.

## 7. Agent tool (`api/src/agents/tools/update-widget-content.tool.ts`)

```ts
export function makeUpdateWidgetContentTool(deps?: { store?: WidgetStoreDeps }) {
  return tool(
    async ({ dashboardId, widgetId, content }) => {
      const result = await updateWidgetContentHandler(
        env.dashboardRoot,
        dashboardId ?? 'default',
        widgetId,
        content,
        'agent',
        deps?.store,
      );
      if (!result.ok) return `Widget not updated: ${result.error}`;
      return `Updated widget "${widgetId}".`;
    },
    {
      name: 'update_dashboard_widget_content',
      description:
        "Update an existing dashboard widget's content by its id. Cannot create, delete, or rename a widget, or change its type.",
      schema: z.object({
        dashboardId: z.string().optional().describe("Defaults to 'default' — the only dashboard that exists today."),
        widgetId: z.string().describe('The target widget\'s id.'),
        content: z
          .record(z.string(), z.unknown())
          .describe(
            "Only the fields you're changing, e.g. { value, unit } for a Big Number widget, " +
              '{ content } for Markdown, { data, color } for Line Graph, { data, colors } for ' +
              'Pie Graph. Anything omitted keeps its current stored value. Optionally include ' +
              "`maintainer`: a short label naming what's keeping this widget up to date (e.g. a script name).",
          ),
      }),
    },
  );
}
```

Follows the established convention: errors return a descriptive string rather than throwing, so the model can self-correct.

## 8. CLI (`bin/widget-update.ts`)

```sh
tsx bin/widget-update.ts --dashboard-id default --id disk-space --data '{"value": 87, "unit": "%", "maintainer": "check-disk-space.sh"}'
```

Parses argv with `node:util`'s `parseArgs`, reads the API's port from `api/src/config/env.ts`, `fetch`s `PATCH http://localhost:${env.port}/api/v1/dashboards/${dashboardId}/widgets/${id}/content` with the parsed `--data` JSON as the body, and on a non-2xx response prints the error to stderr and exits 1. No retry logic — the CLI only ever runs as a script a cron-scheduled task spawned, so the server is guaranteed to already be up.

## 9. UI

- `ui/src/hooks/use-live-events.ts` gains a `widget_updated` case that patches the matching widget (by `id`, within `dashboardId`) in whatever signal currently holds the dashboard's widget list — no refetch needed.
- `widget-renderer.tsx` composes a new shared, presentational `WidgetProvenance` component (badge + relative-time footer) into every per-type widget's card shell, rather than four separate implementations — consistent with this repo's composition-over-customization principle. It renders:
  - `"Manual"` when `source === 'manual'`
  - `"Agent"` when `source === 'agent'` and `maintainer` is unset
  - `"Agent · {maintainer}"` when `source === 'agent'` and `maintainer` is set
  - Nothing is rendered for `'system'` in this issue (D12) — the component's switch has that branch ready for #320, matching the reserved-but-inert enum value.
  - The relative-time footer (e.g. "2m ago") computed from `updatedAt` at render time.

---

## Out of scope (tracked elsewhere)

- System-provided telemetry widgets (what `source: 'system'` actually produces) — [#320](https://github.com/tkottke90/amazing-hashbrown/issues/320).
- Multi-dashboard support — [#316](https://github.com/tkottke90/amazing-hashbrown/issues/316).
- Widget creation/deletion via agent or CLI — explicitly rejected by D10, not deferred.
