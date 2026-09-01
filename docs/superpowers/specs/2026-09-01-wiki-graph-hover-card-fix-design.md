# Wiki Graph Hover Card Disappears Before "Open in Editor" Can Be Clicked — Design

**Date:** 2026-09-01
**Status:** Approved
**Issue:** [#111 — Bug: Wiki graph node hover card disappears before user can click "Open in editor"](https://github.com/tkottke90/amazing-hashbrown/issues/111)

---

## 1. Problem & Root Cause

On the wiki graph view (`ui/src/pages/wiki/graph-view.tsx`), hovering a node shows a card with title, tags, and an "Open in editor" button. Moving the cursor off the node toward the card immediately hides the card, so the button can never be reached.

**Root cause:** the node's `mouseleave` handler (`graph-view.tsx:132-134`) sets `hoveredNode.value = null` synchronously — there is no grace period. Compounding this, the card container (`graph-view.tsx:190-227`) is rendered with `pointer-events-none`; only the button itself opts back in with `pointer-events-auto`. So even if the cursor survives the trip from node to card, the card as a whole never registers the cursor entering it — there's no mechanism to keep the hover state alive while the user crosses the gap or reads the card.

---

## 2. Fix: Close-Delay Timer + Hoverable Card

All changes are confined to `ui/src/pages/wiki/graph-view.tsx`. This is the standard hovercard pattern (used by Radix UI, GitHub hovercards, etc.): don't close on `mouseleave`, schedule a close after a short delay, and cancel that schedule if the cursor lands somewhere that counts as "still interacting."

### State

Add a ref to track the pending close timer, alongside the existing `hoveredNode` signal:

```typescript
const closeTimerRef = useRef<number | null>(null);
```

### Behavior changes

1. **Node `mouseenter`** (currently sets `hoveredNode.value` directly): first calls `cancelClose()` (clears `closeTimerRef.current` if set), then sets `hoveredNode.value` as today. This covers both re-entering the same node and moving directly to a different node — any stale pending-close timer is invalidated before the new hover state is applied.

2. **Node `mouseleave`** (currently sets `hoveredNode.value = null` directly): instead calls `scheduleClose()`, which sets `closeTimerRef.current = window.setTimeout(() => { hoveredNode.value = null; }, 200)`.

3. **Card container**: drop `pointer-events-none` (and the now-redundant `pointer-events-auto` on the button — the whole card is a real hover target now). Add `onMouseEnter={cancelClose}` and `onMouseLeave={scheduleClose}` on the card's outer `<div>`. Entering the card cancels the pending close from the node's `mouseleave`; leaving the card (without returning to the node) schedules the close.

4. **"Open in editor" click handler**: also calls `cancelClose()` and sets `hoveredNode.value = null` immediately, so the card doesn't linger after the user has already acted on it.

5. **Effect cleanup**: the `useEffect`'s existing cleanup (currently just `simulation.stop()`) also clears `closeTimerRef.current` via `clearTimeout` if set, so a pending timer from a previous render/mount can't fire later and write to a stale signal.

`scheduleClose`/`cancelClose` are small local helper functions defined once per effect run, alongside the existing `mouseenter`/`mouseleave` handlers.

### Delay value

200ms. Long enough to move the cursor from the node's edge to the card (which renders ~12px away, per the existing `left: hovered.x + 12` offset) without feeling laggy when the user genuinely moves away.

---

## 3. Testing

No existing test covers `graph-view.tsx`'s rendering — the only test in this area (`ui/test/wiki-build-graph-data.test.ts`, from the prior graph-edges-disappearing fix) covers the pure `buildGraphData` helper, not the component itself. The hover/timer logic here is tightly coupled to real mouse events on a live SVG driven by a d3 force simulation with continuously-updating node positions; isolating it into a unit-testable pure function isn't practical without disproportionate restructuring for a small, self-contained bug fix.

**Verification:** manual, in-browser (via the `run` skill):

- Hover a node → card appears.
- Move the cursor from the node onto the card → card stays visible (does not flicker/disappear mid-transit).
- Click "Open in editor" from the card → navigates to the corresponding document; card closes.
- Move the cursor off the node and away from the card entirely (not toward the card) → card disappears after the short delay, as before.
- Move from one node directly to another → card updates to the new node without incorrectly closing.

---

## 4. Out of Scope

- Touch/keyboard-accessible interaction with the graph (the issue and this fix are scoped to the existing hover-driven UX; switching to a click/focus-triggered popover was considered and explicitly rejected in favor of preserving current behavior).
- Any change to card content, positioning, or styling beyond the `pointer-events` adjustment needed to make it a valid hover target.
