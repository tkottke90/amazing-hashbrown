# Pie Chart Legend & Linked Hover — Design

**Date:** 2026-10-23
**Status:** Approved
**Issue:** N/A — direct design request, no tracked issue

---

## 1. Problem & Goal

`PieChart` (`ui/src/pages/dashboard/pie-chart.tsx`) renders a static D3 SVG pie with no legend and no interaction: a viewer can see relative slice sizes but can't read a category's exact value, or know which color maps to which label, without editing the widget to see its source CSV.

This design adds a legend and a linked hover effect to `PieChart` itself (not a copy per caller), so it reaches all three places that compose it per ADR-0001's "shared presentational piece" comment: the manual CSV-driven Pie Graph widget, the System Widget `pie-graph` display case, and the widget-drawer's Metric live preview.

---

## 2. `PieChart` Changes

### Props — unchanged

```typescript
interface PieChartProps {
  labels: string[];
  values: number[];
  colors?: string[];
}
```

No new prop: the legend isn't optional or configurable, so there's nothing for a caller to pass. All three call sites (`pie-graph-widget.tsx`, `system-widget.tsx`, `widget-drawer.tsx`) keep calling `<PieChart labels={...} values={...} colors={...} />` exactly as today.

### Layout

The outer `data-testid="pie-graph-widget"` div changes from a centered single-item flex (`flex justify-center`) to a row that places the legend beside the chart:

```tsx
<div data-testid="pie-graph-widget" className="relative flex items-center gap-4">
  <svg ref={svgRef} viewBox={`0 0 ${CHART_SIZE} ${CHART_SIZE}`} className="h-40 w-40 shrink-0" />
  <ul
    data-testid="pie-chart-legend"
    className="flex max-h-40 min-w-0 flex-1 flex-col gap-0.5 overflow-y-auto text-xs"
  >
    {/* one row per label */}
  </ul>
</div>
```

- `max-h-40 overflow-y-auto` on the legend list gives it the same 160px budget as the chart (Q10): more categories than fit scroll inside the list rather than growing the card's height.
- Empty-labels case (`labels.length === 0`): render neither the `<svg>`'s arcs (existing behavior, unchanged) nor any `<li>` rows — an empty `<ul>`. (`ui/test/pie-chart.test.tsx`'s existing "renders nothing when labels is empty" test covers the svg side; a new test covers the legend side.)

### Legend row

One `<li data-testid="pie-chart-legend-row">` per label, in the same order as `labels`/`values` (and therefore the same positional color resolution `pie-chart.tsx` already uses — `colors[i % colors.length]` or `getDomainColor(i)`):

```tsx
<li
  key={label}
  data-testid="pie-chart-legend-row"
  className={cn(
    'flex items-center gap-1.5 truncate rounded px-1 py-0.5',
    hoveredIndex.value === i && 'bg-muted',
  )}
  onMouseEnter={(e: MouseEvent) => setHovered(i, e)}
  onMouseLeave={scheduleClose}
>
  <span className="size-2 shrink-0 rounded-full" style={{ background: resolvedColor(i) }} />
  <span className="truncate">{label}</span>
  <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{values[i]}</span>
</li>
```

The swatch (`size-2 rounded-full` + inline `background`) matches `DomainFilter`'s existing color-dot markup (`ui/src/pages/wiki/domain-filter.tsx`) for visual consistency, reading from the same `resolvedColor(i)` helper the D3 draw already computes per slice — factor the `colors && colors.length > 0 ? colors[i % colors.length] ?? getDomainColor(i) : getDomainColor(i)` expression out of the draw effect into a shared `resolvedColor(i)` function used by both the D3 fill and the legend swatch, so the two can never disagree.

Percentage is deliberately not shown in the legend row (Q1) — it only appears in the hover tooltip, described below.

### Hover state

Two signals, matching the `HoveredNode`/`cancelClose`/`scheduleClose` pattern already established in `ui/src/pages/wiki/graph-view.tsx`:

```typescript
const hoveredIndex = useSignal<number | null>(null);
const hoverPos = useSignal<{ x: number; y: number } | null>(null);
const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

`cancelClose`/`scheduleClose` are the same 200ms-debounced pair `graph-view.tsx` uses, for the same reason: moving the pointer from a slice to its legend row (or back) crosses a gap between two separate elements, and an un-debounced `mouseleave` would flash the hover state off and back on in that gap.

Both the SVG slice and the legend row call the same `setHovered(index, event)` on `mouseenter`/`mousemove` (cancels any pending close, sets `hoveredIndex.value = index` and `hoverPos.value` to the pointer position relative to the chart+legend wrapper's bounding rect) and `scheduleClose` on `mouseleave` — this is what makes the linkage in Q4 symmetric: either element sets the exact same two signals, so there's one hover state, not two kept in sync.

### Slice dimming (Q8) — a second, cheap effect

The existing D3 draw effect (`useEffect(..., [labels, values, colors])`) is unchanged except for two additions: each `path` gets `.attr('data-slice-index', i)` and the `mouseenter`/`mousemove`/`mouseleave` handlers described above (mirroring `graph-view.tsx`'s node hover wiring, including computing `event.clientX/clientY` relative to `svg.getBoundingClientRect()`).

A **separate** effect reacts to `hoveredIndex.value` alone:

```typescript
useEffect(() => {
  const svg = svgRef.current;
  if (!svg) return;
  d3Selection
    .select(svg)
    .selectAll<SVGPathElement, unknown>('path')
    .attr('opacity', function () {
      const i = Number(this.getAttribute('data-slice-index'));
      return hoveredIndex.value === null || hoveredIndex.value === i ? 1 : 0.35;
    });
}, [hoveredIndex.value]);
```

Splitting this into its own effect — rather than adding `hoveredIndex.value` to the main draw effect's dependency array — means a hover change only ever updates an `opacity` attribute on already-existing `path` elements; it never re-runs the `pie()`/`enter()`/`append()` join. Rejoining on every `mouseenter` would destroy and recreate the very `path` the pointer is currently over, which is the flicker/interruption `graph-view.tsx` already works around (there, there's nothing to rejoin — this chart's existing full-rebuild-on-every-render-dependency-change behavior is new territory, so it's worth calling out explicitly rather than silently inheriting a flicker).

### Tooltip (Q3)

A single floating tooltip, shown whenever `hoveredIndex.value !== null`, positioned from `hoverPos.value` the same way `graph-view.tsx` positions its node tooltip (clamped so it doesn't run off the chart+legend wrapper), with its own `onMouseEnter={cancelClose}` so hovering the tooltip itself doesn't close it:

```tsx
{
  hoveredIndex.value !== null && hoverPos.value && (
    <div
      data-testid="pie-chart-tooltip"
      className="absolute z-10 rounded-md border border-border bg-card px-2 py-1 text-xs shadow-lg"
      style={{ left: hoverPos.value.x + 8, top: hoverPos.value.y - 8 }}
      onMouseEnter={cancelClose}
    >
      <div className="font-medium">{labels[hoveredIndex.value]}</div>
      <div className="text-muted-foreground">
        {values[hoveredIndex.value]} ({percent(hoveredIndex.value)}%)
      </div>
    </div>
  );
}
```

`percent(i)` is `Math.round((values[i] / values.reduce((a, b) => a + b, 0)) * 100)`. The outer wrapper div's `relative` (shown in Layout above) is what scopes the tooltip's `absolute` positioning to the chart+legend row, not the whole widget card.

The tooltip triggers from hovering either a slice or a legend row, per the same `setHovered` call both wire into — Q3/Q4 together read as one linked hover state with one tooltip, not a chart-only tooltip with a separate legend-only highlight.

---

## 3. Widget Size Minimum

Per ADR-0044, `WIDGET_SIZE_MIN['pie-graph']` (`lib/amazing-hashbrown-widgets/src/internal/widget-field-schemas.ts`) is raised from `{ w: 4, h: 3 }` to give the chart + legend row enough width by construction (Q11) — height is unaffected, since the legend sits beside the chart within the same 160px vertical budget, not below it.

The exact new `w` is a judgment call this spec deliberately doesn't hard-derive from pixel math: the dashboard grid's column width is computed live from the container's rendered width (`use-widget-resize.ts`'s `columnPx = node.getBoundingClientRect().width / w`), not a fixed constant, so there's no single "correct" column count that's exactly right at every viewport width. **Confirm the chosen value in a running `npm run dev` dashboard** (per `ui/AGENTS.md`'s "for UI-visible changes, also run the dev server and check in a browser" rule) at common widths, checking that chart + legend + `gap-4` + the card's `p-4` padding doesn't overflow a widget at its new minimum — `w: 6` (half the 12-column grid) is a reasonable starting point to try first.

`parseWidgetFile` (`lib/amazing-hashbrown-widgets/src/internal/frontmatter.ts`) already defaults a _missing_ `w`/`h` to the type's minimum before schema validation (ADR-0009). Extend that same pre-validation step so an explicit `w`/`h` that's now _below_ the (raised) minimum is clamped up to it too, not just a missing one — this is exactly ADR-0044's scope, and is what makes already-placed Pie Graph widgets narrower than the new minimum load correctly instead of failing `WidgetFrontmatterSchema`'s `.min()` check (Q12):

```typescript
const sizeMin = WIDGET_SIZE_MIN[data['type'] as keyof typeof WIDGET_SIZE_MIN];
if (sizeMin) {
  if (typeof data['w'] !== 'number' || data['w'] < sizeMin.w) data['w'] = sizeMin.w;
  if (typeof data['h'] !== 'number' || data['h'] < sizeMin.h) data['h'] = sizeMin.h;
}
```

No other call site needs a code change: `widget-renderer.tsx` already passes `minW`/`minH` from `WIDGET_SIZE_MIN[type]` generically, so it picks up the raised pie-graph minimum automatically, and `store.ts`'s `createWidget`/`updateWidget` paths already read from the same `WIDGET_SIZE_MIN` constant.

---

## 4. Accessibility & Interaction Scope

Mouse-only for this pass (Q6): no `tabIndex`/`:focus` equivalent on slices or legend rows, and no keyboard-triggered tooltip. Out of scope, not a regression — `PieChart` has no interaction at all today.

---

## 5. Testing

**Unit (`ui/test/pie-chart.test.tsx`)** — existing 4 tests (path count, default palette, colors-prop override/cycling, empty-labels) stay as-is; add:

- Renders one `pie-chart-legend-row` per label, each showing its label text and value.
- Hovering a slice (`fireEvent.mouseEnter` on a `path`) sets `opacity: 0.35` on every other `path` and `0.35` is _not_ applied to the hovered one; the corresponding legend row gets the hover-highlight class.
- Hovering a legend row produces the same slice-opacity result (the reverse linkage), and shows the tooltip with that row's label/value/percentage.
- Empty `labels` renders an empty legend list (no rows), matching the existing empty-chart case.

**Unit (`lib/amazing-hashbrown-widgets`)** — extend whatever test file covers `parseWidgetFile`'s ADR-0009 backward-compat branch: a widget file with an explicit `w: 4` for `type: pie-graph` (the old minimum) parses successfully with `w` clamped up to the new minimum, not rejected by `WidgetFrontmatterSchema`.

**E2E (`e2e/tests/dashboard.spec.ts`)** — extend the existing `add a pie-graph widget with valid CSV` test (line ~331) to also assert `card.getByTestId('pie-chart-legend-row')` has the same count as the `svg path` assertion already there, and add a `@user-workflow` case that hovers a legend row and asserts the tooltip (`pie-chart-tooltip`) appears with the expected label text — covering the one scenario (linked hover) that's hard to assert meaningfully from a unit test alone (real pointer-driven layout, not just a fired DOM event).

---

## 6. Files Changed

| File                                                                 | Change                                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ui/src/pages/dashboard/pie-chart.tsx`                               | Add legend list, `hoveredIndex`/`hoverPos` signals, dimming effect, tooltip; extract `resolvedColor(i)` |
| `ui/test/pie-chart.test.tsx`                                         | Add legend-rendering, slice-hover-dims, legend-hover-links, empty-legend tests                          |
| `lib/amazing-hashbrown-widgets/src/internal/widget-field-schemas.ts` | Raise `WIDGET_SIZE_MIN['pie-graph']`                                                                    |
| `lib/amazing-hashbrown-widgets/src/internal/frontmatter.ts`          | Clamp an explicit too-small `w`/`h` up to the type minimum, not just a missing one (ADR-0044)           |
| `lib/amazing-hashbrown-widgets` test file for `parseWidgetFile`      | Add clamp-of-explicit-value test                                                                        |
| `e2e/tests/dashboard.spec.ts`                                        | Extend pie-graph test with legend-row-count assertion; add hover tooltip `@user-workflow` case          |
| `docs/GLOSSARY.md`                                                   | Already updated (Widget Size entry now cites ADR-0044)                                                  |
| `docs/adr/0044-*.md`                                                 | Already added                                                                                           |

No change needed to `ui/src/pages/dashboard/widget-renderer.tsx`, `store.ts`, `pie-graph-widget.tsx`, `system-widget.tsx`, or `widget-drawer.tsx` — all three `PieChart` callers and the generic `WIDGET_SIZE_MIN`-driven sizing plumbing already pick this up without their own edits.

---

## 7. Out of Scope

- Click-to-filter / toggle-slice-visibility on the legend (Q5) — passive legend only.
- Keyboard-focus equivalent of the hover effect (Q6).
- Responsive stacking of the legend below the chart at narrow widths (Q11) — the raised `WIDGET_SIZE_MIN` is the chosen fix instead.
- Any change to `PieChart`'s color-resolution rules (`Color Override`, `getDomainColor`) beyond extracting the existing expression into `resolvedColor(i)` — behavior is unchanged, just reused by the legend.
