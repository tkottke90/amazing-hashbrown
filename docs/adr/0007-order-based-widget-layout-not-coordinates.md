# Widget layout is order + size, not absolute x/y coordinates

#179's own mockup drag model is "swap with whatever widget you're currently hovering" — a widget can only ever land where another widget already sits, never in arbitrary open grid space. We persist layout as the existing `order` field (now drag-reorderable, not just drawer-set) plus new per-widget `w`/`h` size scalars, and keep the dashboard grid auto-flowing widgets by `order` the same way it already does today — we do not add absolute `x`/`y` grid-cell coordinates per widget.

## Considered Options

- Absolute `(x, y)` grid-cell coordinates per widget (the `react-grid-layout`-style approach) — rejected: the swap-only interaction can never produce two widgets occupying the same cell or a widget in empty space, so `x`/`y` would be able to express layout states the UI never creates, and would need its own collision/packing logic that CSS Grid's `order`-based auto-flow already gives for free.
