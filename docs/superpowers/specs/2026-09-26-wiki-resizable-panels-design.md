# Wiki Resizable Panels — Design

**Date:** 2026-09-26
**Status:** Draft — pending review
**Depends on:** LLM Wiki UI & Direct Authoring Tools (complete — this picks up its deferred "Drag-to-resize split panel" item)

---

## 1. Problem & Goal

The `/wiki` page has fixed column widths: the canvas and the chat are split 65/35 by a CSS grid
(`ui/src/pages/wiki/index.tsx`), and in Document view the file list is a fixed `w-56` sidebar
(`ui/src/pages/wiki/document-view.tsx`). Long page titles truncate, long documents are cramped
next to the chat, and there is no way to give more room to whichever column the user is working in.

Goal: let the user drag the column boundaries to resize them relative to each other, VSCode-style,
with the layout remembered across reloads and a one-click way back to the defaults.

---

## 2. Scope & Constraints

**In scope:**

- Resizable **canvas | chat** split, active in **both** Graph and Document views, sharing one
  persisted width (the chat column must not jump when switching tabs)
- Resizable **files | document** split in Document view (Graph view has no file list)
- Persisting both splits in `localStorage`
- A **Reset layout** icon button in the canvas header that restores both splits to their defaults
- Double-clicking a separator resets that split to its default
- Keyboard resizing of separators (arrow keys) with correct ARIA `separator` semantics
- A **Recenter graph** button overlaid on the graph, pinned to its bottom-right corner, that
  zooms/pans to fit all visible nodes (§5.5)

**Out of scope:**

- Collapsing panels — every panel has a hard minimum and can never collapse
- Server-side / cross-browser persistence of layout
- Mobile layout (the desktop layout is already hidden below `md`; unchanged)
- Vertical splits, adding or rearranging panels
- Automatic re-centring on resize — `GraphView` keeps ignoring container size changes (§5.4);
  recentering is manual, via the button
- Animated recenter transition (would need a new `d3-transition` dependency)
- Auto-fitting the graph on initial load
- `TODO_LIST.md` changes — this item is not tracked there and must not be added

**Constraints:**

- Defaults must reproduce today's layout exactly (65/35 canvas/chat, 224px file list), so nothing
  changes visually until the user drags.
- Resizing the outer split must not remount `IngestionChat` (draft input, scroll position) or
  `GraphView` (simulation state).

---

## 3. Approach

Use shadcn's **Resizable** component, built on **`react-resizable-panels` v4** (4.13.3 at time of
writing), resolved through the existing `react` → `preact/compat` alias the same way `radix-ui` and
`react-markdown` already are.

The v4 API differs from v2/v3 and from older shadcn examples: components are `Group` / `Panel` /
`Separator`; sizes accept pixel numbers or percentage strings; the imperative group handle
(`groupRef`) exposes `getLayout()` / `setLayout()` where `setLayout` takes **percentages only**;
`onLayoutChanged(layout, meta)` reports `meta.isUserInteraction`. Implementation must target this
API, not copy v2/v3 code.

Rejected alternatives:

- **Hand-rolled splitter (signals + CSS grid):** no dependency, but we would own keyboard support,
  ARIA values, pointer capture over the graph SVG, and window-shrink clamping — the parts
  hand-rolled splitters usually get wrong.
- **CSS `resize: horizontal`:** corner-grip only, one-sided, no keyboard support, not VSCode-like.

---

## 4. Architecture

Two nested horizontal groups:

```
index.tsx
└─ Group id="wiki-outer"
   ├─ Panel id="canvas"    defaultSize "65"  minSize 400 (px)
   │    header: [Graph|Document]  …  [DomainFilter (graph only)] [Reset layout]
   │    body:   GraphView | DocumentView
   │                          └─ Group id="wiki-document"
   │                             ├─ Panel id="files"     defaultSize 224 (px)  minSize 160 (px)  maxSize "40"
   │                             ├─ Separator
   │                             └─ Panel id="document"  minSize 320 (px)  (no defaultSize)
   ├─ Separator
   └─ Panel id="chat"      defaultSize "35"  minSize 280 (px)  maxSize "60"
```

Nesting matches the existing component structure (the file list belongs to `DocumentView`) and is
how VSCode composes its layout; flattening to one three-column group would force Graph view to
handle a column it doesn't have.

`document` deliberately has no `defaultSize`: v4's double-click reset resizes the first adjacent
panel that declares one, which must be `files` for the inner separator.

### 4.1 Files

| File                                   | Change                                                                                                                                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui/src/components/ui/resizable.tsx`   | **New.** shadcn Resizable wrapper (added via the shadcn CLI per `ui/AGENTS.md`, reformatted with Prettier, typechecked against Preact). Separator: 1px `bg-border` line, wider invisible hit area, highlight on hover and while dragging. |
| `ui/src/pages/wiki/use-wiki-layout.ts` | **New.** Group/panel IDs, default layouts, `loadLayout`, `saveLayout`, `clearLayout`, `layoutResetCount` signal, `resetWikiLayout()`, `documentDefaultLayout(groupWidthPx)`. Page-scoped per `ui/AGENTS.md`.                              |
| `ui/src/pages/wiki/index.tsx`          | Replace the `65fr 35fr` grid with the outer group; add the Reset layout icon button to the canvas header's right-hand cluster.                                                                                                            |
| `ui/src/pages/wiki/document-view.tsx`  | Replace the `w-56 shrink-0` sidebar + `flex-1` editor row with the inner group.                                                                                                                                                           |
| `ui/src/pages/wiki/graph-view.tsx`     | Add the Recenter graph button; keep the effect's `zoom` behaviour and node data reachable from its click handler via refs (§5.5). No resize handling.                                                                                     |
| `ui/src/pages/wiki/fit-transform.ts`   | **New.** Pure `computeFitTransform(...)` (§5.5).                                                                                                                                                                                          |
| `ui/package.json`                      | Add `react-resizable-panels` (pinned exact, matching the repo's pinning style).                                                                                                                                                           |

---

## 5. Data Flow

### 5.1 Persistence

We own persistence instead of using the library's `useDefaultLayout` hook, because Reset must clear
the `wiki-document` layout while that group is **unmounted** (Graph view). `useDefaultLayout`
chooses its own storage key names; clearing them would mean depending on library internals.

- Storage keys: `wiki-layout:outer`, `wiki-layout:document`.
- Stored value: the library's `Layout` map (`{ [panelId]: percent }`) as JSON.
- Each group: `defaultLayout={loadLayout(id)}` and
  `onLayoutChanged={(layout, meta) => { if (meta.isUserInteraction) saveLayout(id, layout); }}`.
- **Save only on user interaction** (pointer drag release or keyboard resize). When the window
  shrinks, the library clamps panels to their minimums and reports a non-user change; persisting
  that would make a temporarily small window permanently shrink the layout.
- `loadLayout` returns `undefined` (→ library defaults) unless the value parses as JSON, has
  exactly the group's expected panel IDs, and every value is a finite number.
- All `localStorage` access is wrapped in try/catch, mirroring `ui/src/hooks/use-thread.ts`; if
  storage is unavailable the layout still works, it just isn't remembered.

### 5.2 Double-click reset

v4 separators reset their panel to its `defaultSize` on double-click, but do so through the
imperative `resize()` path, which reports `isUserInteraction: false` — so the reset would not be
saved and the old width would return on reload. Each `Separator` therefore also gets an
`onDoubleClick` handler that calls `clearLayout(groupId)`. Rule shared with the Reset button:
**no stored layout means defaults.**

### 5.3 Reset layout button

Icon button (lucide `RotateCcw`, with `aria-label="Reset layout"` and a tooltip) in the
canvas header's right-hand cluster — next to `DomainFilter` in Graph view, alone on the right in
Document view. Calls `resetWikiLayout()`:

1. `clearLayout` for **both** keys (covers the unmounted `wiki-document` group).
2. Increment `layoutResetCount`.
3. Each **mounted** group has an effect on `layoutResetCount` (ignoring its initial value) that calls
   `groupRef.current.setLayout(...)`:
   - outer: `{ canvas: 65, chat: 35 }`
   - document: `documentDefaultLayout(groupElement.clientWidth)` — converts the 224px default to a
     percentage, clamped so `files` stays within its 160px minimum and 40% maximum and `document`
     keeps its 320px minimum.

Remounting groups via a `key` was rejected: remounting the outer group would reset `IngestionChat`
and restart the graph simulation.

### 5.4 Graph view ignores resizes (deliberate)

`graph-view.tsx` reads `svg.clientWidth` / `clientHeight` once per render effect and is **not
changed**. Dragging the canvas|chat separator resizes the SVG element, but the force layout keeps
the centre and domain anchors it computed on its last render — no redraw or simulation reheat while
dragging. The graph lays out for the current size whenever its effect next runs: on mount
(including every switch back from Document view), on graph data refresh, and on domain filter
changes. Users can pan/zoom to reframe in between. This matches today's behaviour on browser window
resize — the Recenter graph button (§5.5) is the manual way back.

### 5.5 Recenter graph button

**Placement:** an icon button absolutely positioned at the graph container's bottom-right
(`absolute bottom-3 right-3`, inside the existing `relative` wrapper in `GraphView`), layered over
the SVG. Lucide `LocateFixed` icon, `aria-label="Recenter graph"`, tooltip "Recenter graph",
styled like the canvas header's small bordered buttons. Stays put when the canvas is resized
because it's anchored to the container, not the SVG content.

**Behaviour — zoom to fit:** sets the d3-zoom transform so every currently rendered node (respecting
the domain filter) fits inside the SVG's **current** `clientWidth` / `clientHeight` with padding.
Node positions are untouched and the simulation is **not** reheated — it only moves the view, so
it fixes every way of getting lost (panned away, zoomed out, canvas resized). The jump is instant
(no transition, see Out of scope).

**Mechanics:**

- The render effect already creates the `zoom` behaviour and the node array; store them in refs
  (`zoomRef`, `nodesRef`) so the click handler can reach them. The refs are refreshed each time the
  effect re-runs, so they always match what's drawn.
- On click: compute node bounds from the nodes' current `x`/`y` expanded by each node's radius,
  call `computeFitTransform(...)`, then `select(svg).call(zoom.transform, transform)`. Going through
  `zoom.transform` keeps d3-zoom's internal state in sync, so the next wheel/drag continues from
  the fitted view rather than jumping back.
- `computeFitTransform({ bounds, width, height, padding, scaleExtent })` is a pure function in
  `fit-transform.ts` returning `{ k, x, y }`:
  - scale `k = min((width - 2·padding) / boundsWidth, (height - 2·padding) / boundsHeight)`,
    clamped to the zoom's existing `scaleExtent` `[0.2, 4]`;
  - translate so the bounds' centre maps to the canvas centre;
  - zero-width/height bounds (a single node) → keep `k = 1` and just centre it.
- Padding: 40px.
- **No nodes rendered** (empty wiki, or every domain filtered off) → button is disabled.

---

## 6. Error Handling

| Situation                                       | Behaviour                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `localStorage` throws (private browsing, quota) | Fall back to defaults / skip saving; no error surfaced           |
| Stored JSON corrupt or from an older schema     | Ignored; defaults apply; overwritten on next user resize         |
| Stored layout violates current min/max          | Library validates and clamps on mount                            |
| Window narrower than the sum of minimums        | Library clamps; the page is already hidden below `md`            |
| Reset while `groupRef.current` is null          | Keys are still cleared; the group picks up defaults when mounted |

---

## 7. Testing

UI developer tests live in `ui/test/` (repo convention for the `ui` workspace). Tags per root
`AGENTS.md`.

### 7.1 Jest — `ui/test/wiki-layout.test.ts` `[unit]`

- `loadLayout` returns `undefined` for: missing key, invalid JSON, wrong panel IDs, non-numeric
  values, and `localStorage` throwing — a bad stored value must never break the page.
- `saveLayout` → `loadLayout` round-trips a layout.
- `resetWikiLayout` clears **both** keys and increments `layoutResetCount`.
- Double-click handler path: `clearLayout(id)` removes only that group's key.
- `documentDefaultLayout(width)` converts 224px correctly at a typical width and clamps at extreme
  widths (e.g. 300px and 4000px).

### 7.2 Jest — `ui/test/wiki-fit-transform.test.ts` `[unit]`

- Bounds larger than the canvas → scaled down so the padded bounds fit, and centred.
- Tiny bounds → scale capped at 4; huge bounds → scale floored at 0.2 (matches the zoom extent,
  so Recenter never produces a zoom level the user couldn't reach by scrolling).
- Zero-size bounds (single node) → `k = 1`, node centred.
- Bounds offset far from the origin (panned away) → translate brings their centre to the canvas
  centre.

### 7.3 Playwright — `e2e/tests/wiki-resizable-panels.spec.ts` (`@smoke`, `@user-workflow`)

`TestSuite` pattern; `page.route()` mocks for wiki endpoints as in `wiki-graph.spec.ts`; CI-safe
(no `@llm`). Assertions compare `boundingBox()` widths with a few pixels' tolerance.

1. Drag the canvas|chat separator left → chat panel widens.
2. Reload → chat width persists.
3. Switch Graph → Document → chat width unchanged (shared split).
4. Drag the files|document separator → file list widens; persists across reload.
5. From **Graph** view, click Reset layout, then switch to Document → both splits at defaults
   (65/35, file list ≈224px). Guards the unmounted-group reset path.
6. After dragging, double-click a separator → resets, and **stays reset after reload**. Guards the
   `isUserInteraction` workaround in §5.2.
7. Focus a separator and press ArrowLeft → it resizes (keyboard accessibility).
8. In Graph view, wait for node positions to settle, drag the empty canvas to pan the nodes out of
   view, click **Recenter graph** → every rendered node's bounding box lies inside the SVG's
   bounding box.
9. Widen the chat panel so the graph canvas shrinks, click **Recenter graph** → every node is
   inside the (now narrower) SVG. Guards the resize trade-off in §5.4.
10. Filter every domain off → Recenter graph button is disabled.

---

## 8. Risks

- **Preact compatibility of `react-resizable-panels` v4.** It declares `react`/`react-dom` peer
  dependencies and relies on hooks and refs that `preact/compat` supports; `radix-ui` and
  `react-markdown` already run through the same alias. Verify with `npm run build` (tsc + vite) and
  the E2E suite before building on it; if it fails, fall back to the hand-rolled approach in §3.
- **Off-centre graph after resizing.** Because `GraphView` ignores resizes (§5.4), widening the
  chat can leave the graph laid out for a wider canvas, with some nodes partly out of view until
  the user clicks Recenter graph (§5.5), pans, or the graph re-renders. Accepted trade-off.
