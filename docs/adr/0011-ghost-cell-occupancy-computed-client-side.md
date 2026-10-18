# Ghost Cell occupancy is computed client-side, read-only, display-only

ADR-0007 rejected absolute `x`/`y` widget coordinates because the swap-only Reorder interaction never needs to know which grid cells are empty. Rendering Ghost Cells (the dashed, 50%-opacity overlay painted over unoccupied cells in Edit Mode) does need that, so the dashboard grid replicates CSS Grid's own row/column auto-placement algorithm in JS purely to compute which cells are currently empty for painting. This occupancy map is recomputed on every render from each widget's `order`/`w`/`h`, is never persisted, and is never consulted by Reorder's drop handling — a drop still only ever lands on whatever widget (or Spacer Widget) is under the pointer, exactly as ADR-0007 describes. This narrows ADR-0007's scope rather than reversing it: that decision was against *persisted* coordinates and *coordinate-based* drag targeting, not against ever knowing which cells are empty for display purposes.

## Considered Options

- Treat Ghost Cells as drop targets too, letting a widget be dropped directly into empty space — rejected: this would require Reorder to resolve a drop position into a grid cell and persist it, reopening exactly the `x`/`y` coordinate model ADR-0007 rejected.
