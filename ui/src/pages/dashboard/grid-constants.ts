/**
 * Shared grid geometry — fixed-unit tracks on both axes (ADR-0010), never
 * content-sized. `GRID_ROW_HEIGHT_PX` is a literal constant since rows have
 * no natural unit the way columns have the container's own width; column
 * width is 1/GRID_COLUMNS of the grid's rendered width, read live from the
 * DOM where a pixel value is actually needed (the resize handle).
 */
export const GRID_COLUMNS = 12;
export const GRID_MAX_ROWS = 8;
export const GRID_ROW_HEIGHT_PX = 88;
