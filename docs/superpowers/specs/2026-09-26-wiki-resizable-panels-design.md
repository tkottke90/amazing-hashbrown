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
- Graph view re-centres its force layout when its container is resized

**Out of scope:**

- Collapsing panels — every panel has a hard minimum and can never collapse
- Server-side / cross-browser persistence of layout
- Mobile layout (the desktop layout is already hidden below `md`; unchanged)
- Vertical splits, adding or rearranging panels
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
| `ui/src/pages/wiki/graph-view.tsx`     | Add a `ResizeObserver` inside the existing render effect (§5.4).                                                                                                                                                                          |
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

### 5.4 Graph resize

`graph-view.tsx` currently reads `svg.clientWidth` / `clientHeight` once per render effect, so the
force layout stays centred on stale dimensions after any resize. Inside the existing effect:

- Observe the SVG with a `ResizeObserver`, coalescing callbacks to one per animation frame and
  ignoring callbacks where the size hasn't changed (including the initial observation).
- On a real change: recompute `computeDomainAnchors(...)` for the new width/height, repoint the
  `x` / `y` forces at the new anchors (and the `width / 2`, `height / 2` fallbacks), then
  `simulation.alpha(0.3).restart()`.
- Leave the zoom/pan transform untouched; nodes drift to the new centre rather than snapping.
- Disconnect the observer and cancel any pending frame in the effect's existing cleanup.

This also fixes the existing behaviour on browser window resize.

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

### 7.2 Jest — `ui/test/wiki-graph-view-resize.test.tsx` `[unit]`

Using the `MockResizeObserver` pattern from `chat-message-scroll-wrapper.test.tsx`: render
`GraphView`, fire a resize with new dimensions, and assert the simulation's `x`/`y` force targets
move to the new anchors and the simulation is reheated.

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

---

## 8. Risks

- **Preact compatibility of `react-resizable-panels` v4.** It declares `react`/`react-dom` peer
  dependencies and relies on hooks and refs that `preact/compat` supports; `radix-ui` and
  `react-markdown` already run through the same alias. Verify with `npm run build` (tsc + vite) and
  the E2E suite before building on it; if it fails, fall back to the hand-rolled approach in §3.
- **Simulation jitter during drag.** Reheating on every animation frame while dragging may look
  busy. If so, lower the reheat alpha or reheat only once the size has been stable for ~100ms.
