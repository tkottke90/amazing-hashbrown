# Non-dense grid auto-flow with fixed-height rows

The dashboard grid uses `grid-auto-flow: row` (never `dense`) with a fixed-unit `grid-auto-rows` (never content-sized `auto`). Dense packing can pull a later, smaller widget backward into a gap an earlier, taller widget left open, visually detaching rendered position from `order` — which would make Reorder's drag-and-drop mental model confusing, since users drag based on what they see, not the underlying sequence. Fixed-unit rows guarantee two widgets both declaring the same `h` render at the same actual height regardless of content; `auto` sizing can't make that guarantee, which would make `h` a non-comparable number across widgets and undermine the per-type Widget Size clamp. Drag-hover target resolution is plain pointer-over-rendered-element hit-testing, not grid-cell coordinate math, so it resolves correctly even where a tall widget's row-span extends its hit area below the row it started in.

## Considered Options

- `grid-auto-flow: row dense` — rejected: breaks the "visual position matches `order`" guarantee Reorder depends on.
- `grid-auto-rows: auto` (content-sized rows) — rejected: makes `h` unpredictable across widgets with different content, undermining the per-type minimum/clamp model.
