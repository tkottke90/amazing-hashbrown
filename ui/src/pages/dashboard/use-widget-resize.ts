import { useRef } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { GRID_COLUMNS, GRID_MAX_ROWS, GRID_ROW_HEIGHT_PX } from './grid-constants';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

interface UseWidgetResizeOptions {
  w: number;
  h: number;
  minW: number;
  minH: number;
  onResize: (w: number, h: number) => void;
}

/**
 * The resize handle's pointer-delta logic (design spec §4.4) — no dnd-kit
 * equivalent exists for this, dnd-kit is drag-only. Clamps live to
 * `[min, GRID_MAX_ROWS/GRID_COLUMNS]`, the same bound the server enforces
 * (ADR-0002/§1.2), so a drag can never visually suggest a size the server
 * would reject. Column width is read from the card's own rendered width at
 * drag start (an approximation that ignores the grid's `gap`) since,
 * unlike row height, it has no fixed pixel constant — it's 1/GRID_COLUMNS
 * of the grid's own rendered width.
 */
export function useWidgetResize({ w, h, minW, minH, onResize }: UseWidgetResizeOptions) {
  const cardRef = useRef<HTMLDivElement>(null);
  const liveSize = useSignal<{ w: number; h: number } | null>(null);
  const drag = useRef<{
    startX: number;
    startY: number;
    columnPx: number;
    startW: number;
    startH: number;
  } | null>(null);

  function onPointerDown(event: PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    const node = cardRef.current;
    if (!node) return;
    const columnPx = node.getBoundingClientRect().width / w;
    drag.current = { startX: event.clientX, startY: event.clientY, columnPx, startW: w, startH: h };
    liveSize.value = { w, h };
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  function onPointerMove(event: PointerEvent) {
    const current = drag.current;
    if (!current) return;
    const deltaColumns = Math.round((event.clientX - current.startX) / current.columnPx);
    const deltaRows = Math.round((event.clientY - current.startY) / GRID_ROW_HEIGHT_PX);
    liveSize.value = {
      w: clamp(current.startW + deltaColumns, minW, GRID_COLUMNS),
      h: clamp(current.startH + deltaRows, minH, GRID_MAX_ROWS),
    };
  }

  function onPointerUp() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    const final = liveSize.value;
    drag.current = null;
    liveSize.value = null;
    if (final && (final.w !== w || final.h !== h)) onResize(final.w, final.h);
  }

  return { cardRef, liveSize, onPointerDown };
}
