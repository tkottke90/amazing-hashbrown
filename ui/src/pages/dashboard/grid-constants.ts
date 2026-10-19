/**
 * Shared grid geometry — fixed-unit tracks on both axes (ADR-0010), never
 * content-sized. Row height is a literal constant (per Density) since rows
 * have no natural unit the way columns have the container's own width;
 * column width is 1/GRID_COLUMNS of the grid's rendered width, read live
 * from the DOM where a pixel value is actually needed (the resize handle).
 */
export const GRID_COLUMNS = 12;
export const GRID_MAX_ROWS = 8;

// Density (see GLOSSARY.md): a dashboard-level setting, 'compact' or
// 'roomy', driving which fixed row height the grid uses. Roomy's exact
// value is an implementation detail, not a design fork — any reasonable
// "give widgets more air" bump works.
export const GRID_ROW_HEIGHT_COMPACT_PX = 88;
export const GRID_ROW_HEIGHT_ROOMY_PX = 120;

export function rowHeightPx(density: 'compact' | 'roomy'): number {
  return density === 'roomy' ? GRID_ROW_HEIGHT_ROOMY_PX : GRID_ROW_HEIGHT_COMPACT_PX;
}
