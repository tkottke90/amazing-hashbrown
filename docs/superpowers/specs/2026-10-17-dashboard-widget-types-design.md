# Dashboard Widget System — Big Number, Line Graph, Pie Graph Widget Types — Design

**Date:** 2026-10-17
**Status:** Draft
**Related:** [Issue #313](https://github.com/tkottke90/amazing-hashbrown/issues/313) (this issue), [Issue #176](https://github.com/tkottke90/amazing-hashbrown/issues/176) (overall vision), [Issue #177](https://github.com/tkottke90/amazing-hashbrown/issues/177) / [Slice 1](./2026-10-15-dashboard-widgets-slice1-design.md) (rendering foundation), [Issue #178](https://github.com/tkottke90/amazing-hashbrown/issues/178) / [Slice 2](./2026-10-16-dashboard-widgets-slice2-design.md) (persistence), [Widget Drawer Raw Mode Toggle](./2026-10-16-widget-drawer-raw-mode-toggle-design.md) (Form/Raw tab + validation-gate mechanism this issue reuses), [Issue #314](https://github.com/tkottke90/amazing-hashbrown/issues/314) (drag/resize persistence, not this issue), [Issue #315](https://github.com/tkottke90/amazing-hashbrown/issues/315) (agent/CLI/system write API, not this issue), [Issue #316](https://github.com/tkottke90/amazing-hashbrown/issues/316) (multi-dashboard UI, not this issue), [Issue #317](https://github.com/tkottke90/amazing-hashbrown/issues/317) (Big Number trend/delta indicator, split out of this design, not this issue). Terminology used throughout (Widget, Dashboard, Widget Frontmatter, Widget Body, CSV Body, Color Override) is defined in [`GLOSSARY.md`](../../../GLOSSARY.md). [ADR-0001](../../adr/0001-d3-for-widget-chart-rendering.md) and [ADR-0002](../../adr/0002-per-type-widget-persistence-shape.md) record the two decisions below that are hard to reverse.

---

## Goal

Add Big Number, Line Graph, and Pie Graph as full, creatable/editable/deletable Widget types, bringing `DashboardWidget` from a 1-member union (Markdown only) to 4. Slice 2's own D10 restricted widget creation/editing to `type: 'markdown'` "entirely, not just optional" — this issue reverses that restriction for all three new types, because #313's acceptance criteria ("Users can add a Big Number widget…") require it.

## Problem

Two things block a straight "just add three more types to the union": store.ts's `createWidget`/`updateWidget`/`writeWidgetFile` hardcode `type: 'markdown'` and a `content: string` field throughout, and there is no established persistence or rendering precedent to inherit — the mockup referenced by prior specs (`docs/Design/v1.10.0-Dashboard-Design.html`) sketches sample data shapes but renders no actual chart (its `<svg>` elements are static type-picker icon glyphs, not data-driven line/pie output). Both the generalized CRUD plumbing and the chart rendering are new ground, not an extension of an existing pattern.

---

## Decisions (and why)

| #   | Decision                                                                                                                                                                                          | Rationale                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Full Add/Edit/Delete UI ships for all three new types in this issue, reversing Slice 2's D10.                                                                                                     | The acceptance criteria say "Users can add" each type; render-only delivery wouldn't satisfy them, and would leave the new types untestable without hand-editing files on disk.                                                                                                |
| D2  | One generic CRUD API (`dashboards.route.ts`/`dashboards.handlers.ts`, unchanged routes), with a single Zod **discriminated union** on `type` validating the request body — not per-type routes.   | Matches the existing route shape (already not nested per-type) and scales to #315's future agent/CLI write path reusing the same handler, with validation that's exhaustive by construction (adding a type without a union branch is a compile error, same spirit as `assertNever`). |
| D3  | Persistence is **per type**, not uniform: Big Number's `value`/`unit` are Widget Frontmatter scalars with no Widget Body; Line Graph's and Pie Graph's series live in the Widget Body as a CSV Body. | See [ADR-0002](../../adr/0002-per-type-widget-persistence-shape.md).                                                                                                                                                                                                             |
| D4  | The CSV Body field is named `data: string` on `LineGraphWidget`/`PieGraphWidget`, not `content`.                                                                                                  | `content` already means "Markdown prose" by convention (`MarkdownWidget.content`); reusing it for CSV text would be the exact kind of fuzzy, overloaded naming the glossary exists to avoid.                                                                                   |
| D5  | CSV Body parsing is deliberately minimal: a required `label,value` header row, no quoted-field escaping. A label containing a comma is a validation error.                                       | Time-series/category labels in practice don't contain commas; full RFC-4180 quoting is real parsing complexity this feature doesn't need.                                                                                                                                       |
| D6  | Big Number's `value` is optional (`value?: number`), omitted from frontmatter when absent — the same convention `subtitle?` already uses. The UI renders `"N/A"` when `value` is absent.          | Lets a Big Number widget be created before a real number exists, without a string-typed escape hatch on the type (`value: number \| 'N/A'` would leak a UI concern into the data model).                                                                                       |
| D7  | Validation: Line/Pie need ≥1 CSV Body row, no upper bound, duplicate labels allowed. Pie Graph values must be `>= 0`; Line Graph values are unrestricted (can be negative).                       | A negative pie slice is meaningless to render; a negative line point (e.g. a temperature delta) is legitimate. No upper bound avoids an arbitrary cap nothing asked for.                                                                                                        |
| D8  | Chart rendering uses `d3-shape`/`d3-scale`, imperatively, matching `graph-view.tsx`'s existing D3 integration shape.                                                                               | See [ADR-0001](../../adr/0001-d3-for-widget-chart-rendering.md).                                                                                                                                                                                                                  |
| D9  | Default segment/line color is `getDomainColor` (`ui/src/pages/wiki/domain-filter.tsx`); overridable per-widget via a Color Override (`color` on Line Graph, `colors` on Pie Graph).                | One categorical-color source for the whole app instead of a second hardcoded palette living under `pages/dashboard/`.                                                                                                                                                            |
| D10 | Color Override values are validated with a strict hex regex (`/^#([0-9a-f]{3}\|[0-9a-f]{6})$/i`); an invalid one fails the save. Pie's `colors` applies positionally to parsed labels and cycles (`colors[i % colors.length]`) when shorter; extra entries are ignored. | Structural validation is cheap and catches a typo before it silently renders wrong; cycling is a simpler mental model than mixing the override palette with the default palette on one chart. |
| D11 | Line Graph's x-axis renders at most ~5 evenly-spaced tick labels regardless of point count.                                                                                                       | Avoids overlapping, unreadable text on a chart with many data points.                                                                                                                                                                                                             |
| D12 | Type is immutable after creation, same as `id` — no "change this widget's type" affordance anywhere in the UI or API.                                                                              | A widget's whole payload shape is defined by its type; "converting" one is really delete-and-recreate, and exposing it as an edit would complicate the Form tab for no real use case.                                                                                           |
| D13 | Big Number's trend/delta indicator (seen in the mockup's sample data) is explicitly **not** part of this issue — tracked as its own follow-up, [Issue #317](https://github.com/tkottke90/amazing-hashbrown/issues/317), separate from #315.                            | #315 is about the *write* surface (agent/CLI/API); a trend arrow is a Big Number rendering concern specific to this issue's types, not a write-path concern — conflating the two would blur what #315 is for.                                                                   |

---

## 1. Types (`lib/amazing-hashbrown-widgets/src/types.ts`)

```ts
export interface BigNumberWidget extends WidgetBase {
  type: 'big-number';
  value?: number; // omitted when absent — UI renders "N/A"
  unit?: string;
}

export interface LineGraphWidget extends WidgetBase {
  type: 'line-graph';
  data: string; // CSV Body: "label,value\n09:00,120\n..."
  color?: string; // Color Override, hex only
}

export interface PieGraphWidget extends WidgetBase {
  type: 'pie-graph';
  data: string; // CSV Body, same shape as LineGraphWidget
  colors?: string[]; // Color Override, positional to parsed labels
}

export type DashboardWidget = MarkdownWidget | BigNumberWidget | LineGraphWidget | PieGraphWidget;
```

`widget-renderer.tsx`'s `switch`/`assertNever` gains three cases; per Slice 1's D5, a missing case fails to compile because `widget.type` in `default` narrows to the unhandled literal(s), not `never`.

## 2. Frontmatter schemas (`lib/amazing-hashbrown-widgets/src/internal/frontmatter.ts`)

A `HexColorSchema` (`z.string().regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)`) is shared by the two chart schemas. One Zod schema per type, combined into a discriminated union on `type`:

```ts
const BigNumberWidgetFrontmatterSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  type: z.literal('big-number'),
  order: z.number(),
  value: z.number().optional(),
  unit: z.string().optional(),
});

const LineGraphWidgetFrontmatterSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  type: z.literal('line-graph'),
  order: z.number(),
  color: HexColorSchema.optional(),
});

const PieGraphWidgetFrontmatterSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  type: z.literal('pie-graph'),
  order: z.number(),
  colors: z.array(HexColorSchema).optional(),
});

const WidgetFrontmatterSchema = z.discriminatedUnion('type', [
  MarkdownWidgetFrontmatterSchema,
  BigNumberWidgetFrontmatterSchema,
  LineGraphWidgetFrontmatterSchema,
  PieGraphWidgetFrontmatterSchema,
]);
```

`parseWidgetFile` validates frontmatter against `WidgetFrontmatterSchema` (not the Markdown-only schema), then — for `line-graph`/`pie-graph` — parses the CSV Body via a new `parseCsvBody(raw: string): {labels: string[], values: number[]} | {error: string}` (internal to `frontmatter.ts`): splits on newlines, requires the literal header `label,value`, requires ≥1 data row, rejects a label containing a comma, and (for `pie-graph` specifically, checked one layer up where the type is known) rejects a negative value.

## 3. Store (`lib/amazing-hashbrown-widgets/src/store.ts`)

`WidgetContentInput` becomes a discriminated union exported from `types.ts`, mirroring D2:

```ts
export type WidgetContentInput =
  | { type: 'markdown'; title: string; subtitle?: string; content: string }
  | { type: 'big-number'; title: string; subtitle?: string; value?: number; unit?: string }
  | { type: 'line-graph'; title: string; subtitle?: string; data: string; color?: string }
  | { type: 'pie-graph'; title: string; subtitle?: string; data: string; colors?: string[] };
```

`createWidget`/`updateWidget` take this union (instead of today's markdown-only shape) and branch on `input.type` to build the right frontmatter + body. `writeWidgetFile` writes an empty body for `big-number`, the CSV text for `line-graph`/`pie-graph`. Slug generation, `order` assignment, and the create/update/delete/raw-overwrite mechanics are unchanged — none of that is type-specific today and none of it needs to become so.

## 4. API (`api/src/routes/v1/dashboards.route.ts` + `dashboards.handlers.ts`)

No route changes. `createWidgetHandler`/`updateWidgetHandler` validate `req.body` against a discriminated-union Zod schema mirroring `WidgetContentInput` (one schema per type, same shape as §2's frontmatter schemas minus `order`), returning a 400 naming which type's validation failed. `GET`/`DELETE` are untouched — a `WidgetLoadResult`'s `ok` branch is already `DashboardWidget`, which already covers all four types once §1 lands.

## 5. UI

### 5.1 Add flow

`widget-drawer.tsx`'s `add` mode gains a type-picker step before the existing fields (icon buttons: Markdown / Big Number / Line Graph / Pie Graph). Per D12, type is fixed once chosen — there's no going back to the picker mid-form, only cancel-and-restart.

- **Big Number form:** Title / Subtitle / Value (`<input type="number">`, left blank = absent/`"N/A"`) / Unit.
- **Line Graph form:** Title / Subtitle / Color (optional hex input) / a `CodeEditor` text box for the CSV Body.
- **Pie Graph form:** Title / Subtitle / Colors (optional, comma-separated hex inputs or repeatable hex fields — implementation detail, not a new mechanism) / a `CodeEditor` text box for the CSV Body.

The CSV text box reuses the exact validation-gate state machine the [Widget Drawer Raw Mode Toggle spec](./2026-10-16-widget-drawer-raw-mode-toggle-design.md) built for its Raw tab (§1 there): Save is locked until the current CSV text has been checked via the existing `validateWidgetRaw`-style dry-run path, generalized to validate a type's Form-tab payload, not just a whole raw file.

### 5.2 Edit / Delete

Each new type gets its own `big-number-widget.tsx` / `line-graph-widget.tsx` / `pie-graph-widget.tsx` component (`ui/src/pages/dashboard/`), each composing the shared, type-agnostic `widget-card.tsx` shell and carrying its own edit (pencil) / delete (trash) icons — parity with `markdown-widget.tsx`, preserving Slice 2's D13 boundary (the shell has no knowledge of widget types). The universal Raw tab (whole-file CodeMirror edit) applies unchanged to all four types, since `serializeWidgetFile`/`parseWidgetFile` are already type-generic once §2 lands.

### 5.3 Rendering

- **`big-number-widget.tsx`:** renders `value` large, `unit` beside it, `"N/A"` when `value` is absent. No chart, no D3.
- **`line-graph-widget.tsx`** / **`pie-graph-widget.tsx`:** a `useRef<SVGSVGElement>` + `useEffect` component per [ADR-0001](../../adr/0001-d3-for-widget-chart-rendering.md), parsing the widget's CSV Body into `{labels, values}` and drawing via `d3-shape`/`d3-scale`. Segment/line color: the widget's Color Override if present, else `getDomainColor` per D9/D10.

### 5.4 New dependencies

`d3-shape`, `d3-scale`, `@types/d3-shape`, `@types/d3-scale` added to `ui/package.json`, alongside the existing `d3-force`/`d3-selection`/`d3-drag`/`d3-zoom`.

### 5.5 Test IDs

New `data-testid`s (to be recorded in `e2e/AGENTS.md`'s table, per its own instructions):

| `data-testid`                | Element                                                      |
| ----------------------------- | ------------------------------------------------------------- |
| `widget-type-picker`          | The Add-flow's type picker step                               |
| `widget-type-option-<type>`   | Each type picker option (`markdown`/`big-number`/`line-graph`/`pie-graph`) |
| `big-number-widget`           | A rendered Big Number widget's root                            |
| `line-graph-widget`           | A rendered Line Graph widget's root (wraps its `<svg>`)        |
| `pie-graph-widget`            | A rendered Pie Graph widget's root (wraps its `<svg>`)         |
| `widget-drawer-csv-editor`    | The CSV `CodeEditor` box in the Add/Edit Form tab (Line/Pie)   |
| `widget-drawer-color-input`   | A Color Override hex input (Line Graph's `color`, Pie Graph's `colors`) |

---

## 6. Testing

Per root `AGENTS.md` and `api`/`ui` `AGENTS.md` conventions:

**`lib/amazing-hashbrown-widgets` (Mocha + Chai):**

- `internal/frontmatter.test.ts` [unit] — extend: the discriminated union validates each new type's frontmatter and rejects a mismatched one (e.g. `big-number` frontmatter missing `value` is still valid since it's optional; a `line-graph` with `order` missing is not); `parseCsvBody` — valid two-column CSV parses to `{labels, values}`; missing/malformed header rejected; a label containing a comma rejected; empty body (0 data rows) rejected; a non-numeric value column rejected.
- `store.test.ts` [unit] — extend: `createWidget`/`updateWidget` for each of the three new types against a temp directory, confirming the right frontmatter/body split per D3; `listWidgets` round-trips all four types correctly sorted by `order`.

**`api/` (Mocha + Chai):**

- `routes/v1/dashboards.handlers.test.ts` [unit] — extend: each new type's create/update 200/201 paths and its own 400 validation failures (e.g. a Pie Graph with a negative value, a Line Graph CSV missing its header, an invalid hex Color Override); confirms the discriminated union rejects a body whose fields don't match its own declared `type`.

**`ui/` (Jest):**

- `dashboard-big-number-widget.test.tsx` [unit] — renders `value`+`unit`; renders `"N/A"` when `value` is absent; edit/delete button presence and callbacks.
- `dashboard-line-graph-widget.test.tsx` / `dashboard-pie-graph-widget.test.tsx` [unit] — renders an `<svg>` from a known CSV fixture; uses the widget's `color`/`colors` when present, `getDomainColor` otherwise; edit/delete button presence and callbacks.
- `dashboard-widget-renderer.test.tsx` [unit] — extend: dispatches each of the three new types to its component; the cast-through-`unknown` invalid-`type` case still triggers `assertNever`.
- `widget-drawer.test.tsx` [unit] — extend: the Add flow's type picker renders all four options and routes to the right per-type fields; each new type's Save is locked until its CSV/color inputs validate; submit calls the service function with the right discriminated payload per type.

**Playwright (`e2e/tests/dashboard.spec.ts`, extend):**

- `@user-workflow` — for each of the three new types: add a widget via the picker + per-type form, reload the page, confirm it renders with its data intact, delete it, reload, confirm it's gone. Cleans up any widget it creates, even on failure.
- `@user-workflow` — attempt to save a Line/Pie widget with an invalid CSV (bad header, non-numeric value, comma-containing label) and confirm Save stays locked with an inline error; attempt an invalid hex Color Override and confirm the same.
- `@smoke` — a dashboard containing one of each widget type (seeded via test setup) renders all four without error on initial load.

---

## 7. Out of scope (tracked elsewhere)

- Drag/resize, position persistence — Issue #314.
- Agent/CLI/system write API, real-time SSE push on widget change — Issue #315 (depends on this issue's type/validation schemas).
- Multi-dashboard create/rename/switch UI — Issue #316.
- Big Number trend/delta indicator — Issue #317 (split out of this design; depends on this issue landing first).
- Any `source`/"updated Xm ago" attribution metadata — not tracked by this issue; folds under #315 per its existing dev notes.
