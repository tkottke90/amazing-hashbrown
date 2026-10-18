import { GRID_COLUMNS } from './grid-constants';

/** Minimum number of ghost rows shown even on a near-empty dashboard (Q9). */
const MIN_GHOST_ROWS = 5;

export interface GridItemSpan {
  /** Sequence position, not necessarily the widget's own `order` scalar — see dashboard-grid.tsx. */
  order: number;
  w: number;
  h: number;
}

/**
 * Replicates CSS Grid's own sparse, row-flow default auto-placement
 * algorithm (never `dense` — ADR-0010) for `GRID_COLUMNS` columns: walking
 * items in ascending `order`, each one is placed at the first cell, scanning
 * forward from a persistent cursor, where its `w×h` box fits without
 * overlapping an already-placed item or overflowing the row. The cursor
 * only ever moves forward (never backtracks to an earlier row once past
 * it), matching the real grid's own placement cursor.
 *
 * Read-only, display-only (ADR-0011) — this occupancy map feeds Ghost Cell
 * rendering only; it is never persisted and never consulted by Reorder's
 * drop handling.
 */
function placeItems(items: GridItemSpan[]): { occupied: Set<string>; bottomMostRow: number } {
  const occupied = new Set<string>();
  let bottomMostRow = 0;
  let cursorRow = 1;
  let cursorCol = 1;

  function fits(row: number, col: number, w: number, h: number): boolean {
    if (col + w - 1 > GRID_COLUMNS) return false;
    for (let r = row; r < row + h; r++) {
      for (let c = col; c < col + w; c++) {
        if (occupied.has(`${r},${c}`)) return false;
      }
    }
    return true;
  }

  const sorted = [...items].sort((a, b) => a.order - b.order);
  for (const item of sorted) {
    let row = cursorRow;
    let col = cursorCol;
    for (;;) {
      let placed = false;
      while (col <= GRID_COLUMNS) {
        if (fits(row, col, item.w, item.h)) {
          placed = true;
          break;
        }
        col++;
      }
      if (placed) break;
      row++;
      col = 1;
    }

    for (let r = row; r < row + item.h; r++) {
      for (let c = col; c < col + item.w; c++) {
        occupied.add(`${r},${c}`);
      }
    }
    bottomMostRow = Math.max(bottomMostRow, row + item.h - 1);

    cursorRow = row;
    cursorCol = col + item.w;
    if (cursorCol > GRID_COLUMNS) {
      cursorRow++;
      cursorCol = 1;
    }
  }

  return { occupied, bottomMostRow };
}

/** `"<row>,<col>"` keys (1-based, matching CSS Grid line numbering) for every occupied cell. */
export function computeOccupiedCells(items: GridItemSpan[]): Set<string> {
  return placeItems(items).occupied;
}

/**
 * Ghost Cell row extent (Q9): grows dynamically with content rather than a
 * fixed total — `max(tallest occupied row + 1, MIN_GHOST_ROWS)` — a
 * deliberate step toward an eventual infinite canvas, not a capacity cap
 * (the dashboard grid itself has never had one; see `GRID_MAX_ROWS`'s own
 * narrower meaning in `grid-constants.ts`).
 */
export function ghostGridRowCount(items: GridItemSpan[]): number {
  const { bottomMostRow } = placeItems(items);
  return Math.max(bottomMostRow + 1, MIN_GHOST_ROWS);
}
