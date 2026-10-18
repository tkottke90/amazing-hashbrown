# Dashboard Grid Whitespace, Ghost Cells & Card Layout — Design

Follow-up to `2026-10-18-dashboard-widget-layout-design.md` (drag reorder,
resize, Widget Size persistence) — three independent fixes surfaced from
hands-on testing of that foundation in non-prod.

## Goal

1. Give users a layout tool for controlling whitespace in a dashboard
   without building real `x`/`y` positioning.
2. In Edit Mode, visualize which grid cells no widget currently occupies.
3. Fix the widget card shell so a widget's own header and footer always
   stay pinned to the card's top/bottom, with only its middle content
   scrolling — today a Markdown widget's overflowing content pushes the
   footer (provenance badge, relative timestamp) outside the card
   entirely, breaking the card's visual bounds.

## Problem

A screenshot from non-prod testing shows a Markdown widget whose content
is long enough that the card's footer row renders below the card's own
visible bottom edge — `WidgetCard` (`ui/src/pages/dashboard/widget-card.tsx`)
today stacks `{children}` (a widget type's whole content, plus its own
Edit/Delete button row) and the provenance footer as plain flex children
with no scroll boundary, so the card grows to fit its longest child
instead of clipping it.

## Decisions (and why)

Grilled with the user across four rounds; full reasoning for anything
hard to reverse lives in the ADRs cited below. See `GLOSSARY.md` for
**Spacer Widget**, **Ghost Cell**, and the updated **Edit Mode** entry.

- Spacer Widget is a genuine 5th `DashboardWidget` type, not a special
  case bolted onto the grid — it rides the existing `order`/Reorder/
  resize/persistence machinery (order-not-coordinates per ADR-0007)
  exactly like Markdown/Big Number/Line Graph/Pie Graph do today.
- Ghost Cell occupancy is computed client-side, read-only, display-only —
  ADR-0011, which narrows ADR-0007's scope without reopening it (a Ghost
  Cell is never a drop target).
- Ghost Cell extent is dynamic (`max(tallest occupied row + 1, 5)`),
  recomputed on every change, rather than a fixed total — a deliberate
  step toward an eventual infinite canvas, and consistent with the fact
  that `GRID_MAX_ROWS` (`grid-constants.ts`) was never actually a total-
  dashboard cap — it only ever clamped one widget's resizable height
  (`use-widget-resize.ts`), and keeps doing exactly that, unchanged.
- The widget card shell adopts a shadcn-style compound-component split —
  `WidgetHeader`/`WidgetContent`/`WidgetAction`/`WidgetFooter` as explicit
  sibling children, `WidgetCard` reduced to a bare flex-column shell plus
  the one piece of overlay chrome that doesn't belong in the stack (the
  resize handle + live-size badge). This is the AGENTS.md "composition
  over customization" principle applied directly: the shared shape is
  presentation, so it's extracted as small composable pieces every widget
  type (and the error card, and the Spacer) assembles from, rather than
  widening `WidgetCard`'s own prop surface.

## 1. Spacer Widget

### 1.1 Types (`lib/amazing-hashbrown-widgets/src/types.ts`)

```ts
export interface SpacerWidget extends WidgetBase {
  type: 'spacer';
}

export type DashboardWidget =
  MarkdownWidget | BigNumberWidget | LineGraphWidget | PieGraphWidget | SpacerWidget;
```

`WidgetContentInput` gains a title/subtitle-free variant — the drawer
never collects either for a Spacer:

```ts
export type WidgetContentInput =
  | ... // existing 4 variants, unchanged
  | { type: 'spacer' };
```

The store assigns a fixed `title: 'Spacer'` on create (never user-edited,
never shown) so `WidgetBase.title: string` stays non-optional for every
type — no change to the shared field, just a type whose UI never surfaces
it. `subtitle` stays `undefined`. No Widget Body — same frontmatter-only
persistence shape Big Number already uses (ADR-0002).

### 1.2 Per-type minimum (`src/internal/widget-field-schemas.ts`)

```ts
export const WIDGET_SIZE_MIN = {
  // ...existing 4 entries...
  spacer: { w: 1, h: 1 },
};

export const SpacerWidgetFrontmatterSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  type: z.literal('spacer'),
  order: z.number(),
  w: z.number().min(WIDGET_SIZE_MIN.spacer.w).max(WIDGET_SIZE_MAX.w),
  h: z.number().min(WIDGET_SIZE_MIN.spacer.h).max(WIDGET_SIZE_MAX.h),
  source: WidgetSourceSchema,
  maintainer: WidgetMaintainerSchema,
});
```

Added to `WidgetFrontmatterSchema`'s and `DashboardWidgetSchema`'s
discriminated unions, same as every other type. `store.createWidget`
assigns `w`/`h` at `WIDGET_SIZE_MIN.spacer` unconditionally, same as every
other type (§1.4 of the drag/resize design).

### 1.3 Drawer (`ui/src/pages/dashboard/widget-drawer.tsx`)

New `SelectItem value="spacer"` ("Spacer") in the Add-mode type picker.
When `widgetType.value === 'spacer'`, the Title/Subtitle `Input`s and
every type-specific field section are skipped entirely — `typeSpecificContentFields()`
returns `{ type: 'spacer' as const }` and `buildWidgetContentInput()`
omits `title`/`subtitle` for this type rather than sending an empty
string. No validation gate (`needsValidationGate()` stays `false` for
`spacer`, same as Markdown/Big Number) — there's nothing to validate.

### 1.4 Rendering (`widget-renderer.tsx`, new `spacer-widget.tsx`)

Outside Edit Mode: renders nothing but its own grid cell (`grid-column`/
`grid-row` spans from `w`/`h`, no visible box at all — truly blank space).
In Edit Mode: renders `WidgetCard` with a `WidgetHeader` (generic
"Spacer" label + drag grip) and a `WidgetAction` containing a single
Delete button (no Edit — there's no drawer, nothing to edit) — no
`WidgetContent`/`WidgetFooter`. Reusing `WidgetAction` for this, rather
than inventing a one-off delete affordance elsewhere on the card, keeps
every widget type deleting through the same mechanism; Delete calls the
existing `deleteWidget` API directly, same as every other widget type's
`WidgetAction`.

## 2. Ghost Cell

Purely a `dashboard-grid.tsx` rendering concern — no persistence, no API
change, no new widget-level component.

### 2.1 Occupancy computation

A new pure function, `computeOccupiedCells(items: {order, w, h}[]): Set<string>`
(`"<row>,<col>"` keys), replicates CSS Grid's own sparse, row-flow default
placement algorithm (never `dense` — ADR-0010) for `GRID_COLUMNS` (12)
columns: walking `items` in `order`, for each one scan forward from the
current row cursor for the first row with a `w`-wide contiguous free run,
place it, mark its `w×h` cells occupied, advance. This must produce the
exact same placement the real grid's CSS already computes (since Ghost
Cells need to land in the gaps between real rendered widgets, not drift
from them) — covered by dedicated unit tests (§4) checking both against
hand-computed occupancy and, where feasible, against the actual rendered
`getBoundingClientRect()` positions in a component test.

### 2.2 Extent

```ts
function ghostGridRowCount(items: {order, w, h}[]): number {
  const bottomMostRow = /* derived from computeOccupiedCells */;
  return Math.max(bottomMostRow + 1, 5);
}
```

Recomputed on every render from the current widget list — grows as
widgets/Spacers are added, moved, or resized; never shrinks below 5 rows
even on a near-empty dashboard, so the grid reads as a real workspace
rather than a few cards adrift in empty space.

### 2.3 Rendering

In Edit Mode only, one absolutely-positioned, non-interactive
(`pointer-events-none`) `div` per empty cell (dashed border, 50% opacity),
placed in the same CSS grid container via explicit `gridColumn: <col> / span 1`
/ `gridRow: <row> / span 1` (not `span` relative to auto-flow, since these
are exact cell placements, not flow-participating items) so they align
pixel-for-pixel with real widgets. Rendered behind real widgets in stacking
order. Per ADR-0011: never a drop target, never consulted by Reorder.

## 3. Widget card compound layout

### 3.1 `WidgetCard` (`widget-card.tsx`)

Reduced to a `flex flex-col h-full` shell: the border/padding/rounded
styling it has today, plus the resize handle and live-size badge
(unchanged, still absolutely positioned, still gated on `editMode`/`w`/`h`/
`onResize`). No longer builds a header or footer internally — `children`
is rendered as-is between the card's own padding edges.

### 3.2 New compound components (same directory)

- **`WidgetHeader`** — title/subtitle text block + the drag-grip button
  (gated on `editMode`/`dragHandleProps`, same logic `WidgetCard` has
  today). Natural height (no `flex-1`).
- **`WidgetContent`** — wraps a widget type's substantive content. Owns
  `flex-1 min-h-0 overflow-auto` itself (not applied by `WidgetCard`) —
  this is the one piece of the stack allowed to scroll, and the only
  thing the Markdown-overflow bug (§Problem) was ever about.
- **`WidgetAction`** — the Edit/Delete button row. Natural height.
- **`WidgetFooter`** — the provenance badge + relative timestamp, same
  markup `WidgetCard` renders today, just moved into its own component.
  Natural height.

All four are plain presentational wrappers with no type-specific
knowledge — same boundary principle D13 (`2026-10-16-dashboard-widgets-slice2-design.md`)
already drew for edit/delete controls living on each widget type, not the
shared shell.

### 3.3 Per-widget-type updates

`MarkdownWidget`, `BigNumberWidget`, `LineGraphWidget`, `PieGraphWidget`
each restructure their `WidgetCard` children from one flat block into:

```tsx
<WidgetCard
  editMode={editMode}
  dragHandleProps={dragHandleProps}
  w={w}
  h={h}
  minW={minW}
  minH={minH}
  onResize={onResize}
>
  <WidgetHeader
    title={widget.title}
    subtitle={widget.subtitle}
    editMode={editMode}
    dragHandleProps={dragHandleProps}
  />
  <WidgetContent>{/* existing type-specific content */}</WidgetContent>
  <WidgetAction>{/* existing Edit/Delete buttons */}</WidgetAction>
  <WidgetFooter
    source={widget.source}
    maintainer={widget.maintainer}
    updatedAt={widget.updatedAt}
  />
</WidgetCard>
```

`WidgetErrorCard` becomes `WidgetHeader` (fixed title "Unable to load this
widget") → `WidgetContent` (the parse error text) → `WidgetAction` (the
"Edit raw file" link) — no `WidgetFooter`, a file that failed to parse has
no real provenance. The Spacer's Edit-Mode card (§1.4) uses `WidgetHeader`

- `WidgetAction` (Delete only).

## 4. Testing

Per the root `AGENTS.md`: every piece below ships with tests in the same
PR.

- **`lib/amazing-hashbrown-widgets`** (unit): `SpacerWidgetFrontmatterSchema`
  clamp at/above/below `WIDGET_SIZE_MIN.spacer`; `createWidget` for
  `type: 'spacer'` assigns the fixed title and type-minimum size; a
  persisted Spacer file round-trips with no body.
- **`api/`** (orchestration): `createWidgetHandler` accepts `{type: 'spacer'}`
  with no `title`/`subtitle` in the request body.
- **`ui/`** (unit):
  - `computeOccupiedCells`/`ghostGridRowCount` — hand-computed occupancy
    scenarios (widgets of varying `w`/`h` with gaps, a near-empty
    dashboard staying at the 5-row floor, a dashboard taller than 5 rows
    growing past it); confirms it never flags a cell a real widget
    occupies as empty.
  - `WidgetHeader`/`WidgetContent`/`WidgetAction`/`WidgetFooter` render
    their respective content; `WidgetContent` carries the
    `overflow-auto`/`flex-1` classes.
  - Each widget type's test extends to assert its content now renders
    inside `WidgetContent` and its action buttons inside `WidgetAction`.
  - Spacer: hidden (no visible box) with `editMode={false}`; shows
    `WidgetHeader`/grip/resize-handle/`WidgetAction` Delete button with
    `editMode={true}`; participates in the existing Reorder/resize
    orchestration tests the same as any other widget.
  - `dashboard-grid.tsx`: Ghost Cells render only in Edit Mode, only over
    cells `computeOccupiedCells` reports empty, and are `pointer-events-none`.
- **E2E** (`e2e/tests/dashboard.spec.ts`, `@user-workflow`): add a Spacer,
  confirm it's invisible outside Edit Mode and visible/draggable inside
  it, reorder it among real widgets, reload, confirm order persists;
  enter Edit Mode on a dashboard with a long Markdown widget, confirm its
  footer stays visible at the card's bottom edge while its content area
  scrolls independently (regression test for the screenshot bug).

## 5. Out of scope (deferred to future issues)

- True infinite canvas (removing the `max(…, 5)` floor and letting the
  grid grow without any row-count heuristic) — this spec's dynamic Ghost
  Cell extent is a deliberate step toward it, not the thing itself.
- Ghost Cells or Spacer Widgets as drop targets — reorder stays
  swap/splice-onto-an-existing-widget only, per ADR-0007/ADR-0011.
- Mobile/touch layout for Spacer or Ghost Cell — both are desktop-only,
  matching the existing Edit Mode/grid breakpoint split.
- Multi-dashboard behavior — unaffected; only the single `default`
  dashboard exists (#316).
