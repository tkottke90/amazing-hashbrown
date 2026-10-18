import { computeOccupiedCells, ghostGridRowCount } from '@/pages/dashboard/ghost-cells';

describe('ghost-cells', () => {
  describe('computeOccupiedCells', () => {
    it('marks every cell a single widget spans [unit]', () => {
      const occupied = computeOccupiedCells([{ order: 0, w: 3, h: 2 }]);
      const expected = ['1,1', '1,2', '1,3', '2,1', '2,2', '2,3'];
      expect([...occupied].sort()).toEqual(expected.sort());
    });

    it('never flags a cell a real widget occupies as empty, leaving a gap for a narrower sibling [unit]', () => {
      // A 6-wide widget followed by a 3-wide one: the 3-wide one continues
      // in the same row (cols 7-9), never overlapping the first.
      const occupied = computeOccupiedCells([
        { order: 0, w: 6, h: 2 },
        { order: 1, w: 3, h: 1 },
      ]);
      for (let c = 1; c <= 6; c++) {
        expect(occupied.has(`1,${c}`)).toBe(true);
        expect(occupied.has(`2,${c}`)).toBe(true);
      }
      expect(occupied.has('1,7')).toBe(true);
      expect(occupied.has('1,8')).toBe(true);
      expect(occupied.has('1,9')).toBe(true);
      // The second widget is only 1 row tall — row 2 past its own columns stays empty.
      expect(occupied.has('2,7')).toBe(false);
    });

    it('wraps to the next row when a widget no longer fits in the current row (non-dense, ADR-0010) [unit]', () => {
      // 8-wide then another 8-wide: the second can't fit in cols 9-12 (only
      // 4 columns remain), so it wraps to row 2 — it does NOT backfill into
      // the narrower gap left in row 1, matching non-dense packing.
      const occupied = computeOccupiedCells([
        { order: 0, w: 8, h: 1 },
        { order: 1, w: 8, h: 1 },
      ]);
      expect(occupied.has('1,9')).toBe(false);
      for (let c = 1; c <= 8; c++) {
        expect(occupied.has(`2,${c}`)).toBe(true);
      }
    });

    it('resorts by order internally, independent of array position [unit]', () => {
      const occupied = computeOccupiedCells([
        { order: 1, w: 4, h: 1 },
        { order: 0, w: 4, h: 1 },
      ]);
      // order:0 item placed first (cols 1-4), order:1 item right after (cols 5-8).
      expect(occupied.has('1,1')).toBe(true);
      expect(occupied.has('1,5')).toBe(true);
    });

    it('returns an empty set for no items', () => {
      expect(computeOccupiedCells([])).toEqual(new Set());
    });
  });

  describe('ghostGridRowCount', () => {
    it('floors at 5 rows for an empty dashboard [unit]', () => {
      expect(ghostGridRowCount([])).toBe(5);
    });

    it('floors at 5 rows for a dashboard shorter than that [unit]', () => {
      expect(ghostGridRowCount([{ order: 0, w: 3, h: 2 }])).toBe(5);
    });

    it('grows to tallest occupied row + 1 once content exceeds the floor [unit]', () => {
      expect(ghostGridRowCount([{ order: 0, w: 3, h: 6 }])).toBe(7);
    });

    it('accounts for every item, not just the first [unit]', () => {
      const items = [
        { order: 0, w: 3, h: 2 },
        { order: 1, w: 3, h: 8 },
      ];
      // second item wraps to row 1 too (fits beside the first), spanning rows 1-8.
      expect(ghostGridRowCount(items)).toBe(9);
    });
  });
});
