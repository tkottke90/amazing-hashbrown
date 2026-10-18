# Dashboard Widget Layout — Drag Reorder & Resize, Persisted — Design

Resolves #314.

## Goal

Let a user, while in Edit Mode, drag a widget to reorder it among the
dashboard's other widgets and resize it via a corner handle — with both
changes persisted to disk immediately, surviving reload, and visible on
every other open dashboard tab without a manual refresh.

## Problem

#314 is filed as "the persistence follow-up to #179" (#179 supposedly
having built the edit-mode toggle and resize handles, with drag-and-drop
visible but non-persistent). In practice, #179 was closed by
`tkottke90/amazing-hashbrown#312` — an unrelated PR (the widget drawer's
Form/Raw toggle). No edit-mode toggle, resize handle, or drag code exists
anywhere in `ui/src`. This spec therefore covers the entire foundation
(toggle, resize, reorder) plus its persistence, not just a thin
persistence layer bolted onto existing UI.

`WidgetBase` (`lib/amazing-hashbrown-widgets/src/types.ts`) today only
carries `order` — no size field exists at all. #179's own issue text
(quoting the design mockup, `docs/Design/v1.10.0-Dashboard-Design.html`)
is the only source of real sizing values in the repo: a 12-column grid,
per-type minimums `{big-number: 2×2, line-graph: 4×3, pie-graph: 4×3,
markdown: 3×2}`, and a `[min, 12×8]` clamp. This spec takes those values
as authoritative.

## Decisions (and why)

Grilled with the user across five rounds; full reasoning lives in the
ADRs cited below — this section only indexes them. See `GLOSSARY.md` for
**Widget Metadata**, **Widget Size**, **Edit Mode**, and **Reorder**.

- Layout is `order` + **Widget Size** (`w`/`h`), never absolute `x`/`y`
  coordinates — ADR-0007.
- Dragging a widget onto another is a list-**splice** (every widget
  between the old and new slot shifts by one), not #179's described
  2-item swap — a deliberate scope increase, persisted through a new
  atomic endpoint with its own bulk broadcast event — ADR-0008.
- A widget file predating `w`/`h` defaults to its type's minimum at parse
  time; no migration script — ADR-0009.
- The grid uses non-dense `row` auto-flow with fixed-unit row tracks on
  both axes, so rendered position always matches `order` and `h` is a
  comparable number across widgets — ADR-0010.
- Per-type minimums/clamp are enforced as schema validation, the same
  per-type pattern ADR-0002 already established for frontmatter scalars
  vs. CSV body.
- Writes stay UI-only (`source: 'manual'`) — no Agent/CLI access to
  position or size, consistent with Widget Metadata's existing write-path
  restriction (ADR-0004's two-write-paths split).
- No optimistic locking on either write path — last write wins, same as
  every other widget write today.

## 1. Data model (`lib/amazing-hashbrown-widgets`)

### 1.1 `WidgetBase` (`src/types.ts`)

Add Widget Size to the fields every widget shares:

```ts
export interface WidgetBase {
  // ...existing fields...
  /** Widget Size (see GLOSSARY.md) — grid column/row span. */
  w: number;
  h: number;
}
```

### 1.2 Per-type minimums (`src/internal/widget-field-schemas.ts`)

Each per-type Widget Frontmatter schema gains `w`/`h` validation: `w`
bounded to `[type minimum w, 12]`, `h` to `[type minimum h, 8]` —
mirroring how each schema already validates its own type-specific
scalars (ADR-0002):

```ts
const SIZE_MIN: Record<DashboardWidget['type'], { w: number; h: number }> = {
  'big-number': { w: 2, h: 2 },
  'line-graph': { w: 4, h: 3 },
  'pie-graph': { w: 4, h: 3 },
  markdown: { w: 3, h: 2 },
};
```

### 1.3 Backward-compat default (`src/internal/frontmatter.ts`)

The frontmatter parser defaults a missing `w`/`h` to that widget type's
`SIZE_MIN` entry (ADR-0009) — same spot that already defaults a missing
`source` to `'manual'`.

### 1.4 New widgets (`src/store.ts`)

`createWidget` sets `w`/`h` to the type's minimum unconditionally;
`WidgetContentInput` and the Add drawer get no size fields (resizing is
the resize handle's job, not a form field). `order` continues to be
assigned as `max + 1`, unchanged from today.

### 1.5 Reorder (`src/store.ts`)

New `reorderWidget(dashboardRoot, dashboardId, movedId, targetId)`:
loads every widget in the dashboard, computes the spliced `order`
sequence (move `movedId` to immediately before `targetId`'s current
position, shifting everything between), and writes every widget whose
`order` changed in one atomic operation — all files written, or none
(ADR-0008). A `movedId === targetId` no-op short-circuits before any
write.

## 2. API (`api/src/routes/v1/dashboards.{route,handlers}.ts`)

### 2.1 Resize

No new route. The existing `PATCH /:dashboardId/widgets/:id` (full-replace,
drawer write path) already accepts the full widget; `updateWidgetHandler`
now also accepts `w`/`h` in the body, validated by §1.2's schema. This is
called directly from the grid's resize handle, bypassing the drawer UI —
same handler, same `source: 'manual'` stamp, same `widget_updated`
broadcast, just a different caller.

### 2.2 Reorder

New sibling route, mirroring the existing `/content` and `/raw` siblings:

```
PATCH /api/v1/dashboards/:dashboardId/widgets/:id/reorder
Body: { targetWidgetId: string }
```

`reorderWidgetHandler` (new, same `HandlerResult<T>` shape as every other
handler in this file — see `api/AGENTS.md`) calls `store.reorderWidget`
and broadcasts once (§3). 404 if either widget id doesn't exist in the
dashboard; 400 for a missing/malformed `targetWidgetId`.

## 3. Broadcast (`lib/llm-common-types/src/chat/broadcast-events.ts`)

New event, alongside the existing `WidgetUpdatedSchema`:

```ts
const DashboardReorderedSchema = z.object({
  type: z.literal('dashboard_reordered'),
  dashboardId: z.string(),
  widgets: z.array(DashboardWidgetSchema), // every widget whose order changed
});
```

Added to `AppBroadcastEventSchema`'s discriminated union. `ui/src/hooks/use-live-events.ts`
and `use-dashboard-widgets.ts` handle it by patching every listed widget
in place — the same "full current value, no extra round-trip" shape
`widget_updated` already uses, just plural. Resize keeps firing
`widget_updated` (singular) unchanged.

## 4. UI (`ui/src/pages/dashboard/`)

### 4.1 Grid (`dashboard-grid.tsx`)

Replaces the current `grid-cols-1 → sm:grid-cols-2 → lg:grid-cols-3`
responsive stack. At and above the breakpoint where Edit Mode is
available (1024px — the same breakpoint `ui/src/pages/workspaces/[id].tsx`
already uses to switch the Tasks board between its five-lane desktop view
and `TaskListMobile`): a 12-column CSS
grid, `grid-auto-flow: row` (never `dense`), fixed-unit
`grid-template-columns`/`grid-auto-rows` on both axes (never
content-sized) — ADR-0010. Each widget: `grid-column: span {w}`,
`grid-row: span {h}`. Below that breakpoint: single-column stack by
`order`, `w`/`h` ignored entirely.

### 4.2 Edit Mode

New toggle button (dashboard header/toolbar), client-side signal state
only — never persisted (every load starts in view mode). While active:
every widget shows its drag handle and resize handle; the rest of the
card's existing click-to-open-drawer behavior is unaffected, in or out of
Edit Mode.

### 4.3 Drag handle (Reorder)

A dedicated grip icon in each widget's header/title-bar region — not the
whole card, and not the resize corner (keeping the two gestures on
disjoint hit areas). Hovering another widget while dragging highlights it
as the drop target; dropping calls §2.2's endpoint with that widget's id.
Dropping outside any widget, or Escape mid-drag, snaps back with no
request sent. Target resolution is pointer-over-rendered-element
hit-testing (works correctly against a multi-row-height widget's full
rendered box), not grid-cell coordinate math.

### 4.4 Resize handle (Widget Size)

A single handle at each widget's bottom-right corner, pointer-delta
based, changing `w` and `h` together, clamped client-side to
`[type minimum, 12×8]` as the user drags (matching §1.2's server-side
bound so a drag can never visually suggest a size the server would
reject). On release, calls §2.1.

## 5. Testing

Per the root `AGENTS.md`: every piece below ships with tests in the same
PR.

- **`lib/amazing-hashbrown-widgets`** (unit): per-type `w`/`h` clamp
  validation (at minimum, above minimum, below minimum, above `12×8`);
  backward-compat default for a widget file missing `w`/`h`; new-widget
  creation sets type-minimum size; `reorderWidget`'s splice arithmetic
  (move forward, move backward, move-to-self no-op, move to either end of
  the sequence) and its atomicity (a mid-write failure leaves no partial
  state — the existing per-file-write test pattern this package already
  uses for its path-traversal guard applies here too).
- **`api/src/routes/v1/dashboards.handlers.test.ts`** (orchestration):
  `updateWidgetHandler` accepts `w`/`h`; new `reorderWidgetHandler`'s
  success/404/400 paths and its broadcast call, following the existing
  spy-on-`broadcast` pattern already in this file.
- **`ui/`** (unit/orchestration): grid auto-flow renders widgets at
  the expected `grid-column`/`grid-row` spans for a given widget list;
  Edit Mode toggle shows/hides handles and doesn't persist across a
  simulated reload; resize handle clamps to the per-type bound during
  drag; `use-live-events`/`use-dashboard-widgets` handling of
  `dashboard_reordered`.
- **E2E** (`e2e/tests/dashboard.spec.ts`, `@user-workflow`): enter Edit
  Mode, drag a widget to reorder, reload, confirm the new order persists;
  resize a widget, reload, confirm the new size persists; confirm a
  second (mocked or real second client) tab receives the reorder without
  a manual refresh.

## 6. Out of scope (deferred to future issues)

- Touch/mobile drag or resize — desktop-only, matching the Tasks board's
  existing split.
- Keyboard-operable reposition (accessibility parity) — not this issue's
  concern; #314 is specifically the persistence+foundation follow-up, not
  an accessibility pass.
- Multi-dashboard reorder/resize — only the single `default` dashboard
  exists (#316).
- Optimistic locking / conflict resolution on concurrent reorders —
  accepted as last-write-wins; this is a single-user personal dashboard.
- A size field on the Add/creation drawer — new widgets always start at
  their type's minimum; sizing happens via the resize handle after
  creation.
