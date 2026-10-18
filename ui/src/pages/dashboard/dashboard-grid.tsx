import { useSignal } from '@preact/signals';
import type { JSX } from 'preact';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { WidgetLoadResult } from '@tkottke90/amazing-hashbrown-widgets/types';
import { showToast } from '@/lib/toast';
import { useIsDesktopViewport } from '@/hooks/use-media-query';
import { patchDashboardWidgets } from '@/hooks/use-dashboard-widgets';
import { reorderWidget, DEFAULT_DASHBOARD_ID } from '@/services/dashboard-api';
import { WidgetRenderer } from './widget-renderer';
import { GRID_COLUMNS, GRID_ROW_HEIGHT_PX } from './grid-constants';
import { computeOccupiedCells, ghostGridRowCount, type GridItemSpan } from './ghost-cells';

interface DashboardGridProps {
  results: WidgetLoadResult[];
  onChanged: () => void;
  editMode: boolean;
}

function resultKey(result: WidgetLoadResult): string {
  return result.status === 'ok' ? result.widget.id : result.id;
}

// A widget file that fails to parse carries no real Widget Size — it gets a
// small fixed span, and never participates in drag/resize (design spec §6).
const ERROR_CARD_SPAN = { w: 3, h: 2 };

function resultSpan(result: WidgetLoadResult): { w: number; h: number } {
  return result.status === 'ok' ? { w: result.widget.w, h: result.widget.h } : ERROR_CARD_SPAN;
}

// Rendering always reflects `order`, never just whatever position a patch
// happened to leave the array in (ADR-0010) — ok entries ascending by
// order, error entries appended after, same rule listWidgets already
// applies server-side.
function sortedResults(results: WidgetLoadResult[]): WidgetLoadResult[] {
  const ok = results.filter(
    (r): r is Extract<WidgetLoadResult, { status: 'ok' }> => r.status === 'ok',
  );
  const errors = results.filter((r) => r.status === 'error');
  return [...ok.sort((a, b) => a.widget.order - b.widget.order), ...errors];
}

// dnd-kit's own rendered-element hit-testing, never grid-cell coordinate
// math (design spec §4.3/ADR-0010) — prefer whatever's directly under the
// pointer, falling back progressively so a fast drag never loses its target.
const collisionDetection: CollisionDetection = (args) => {
  const pointerHits = pointerWithin(args);
  if (pointerHits.length > 0) return pointerHits;
  const overlaps = rectIntersection(args);
  return overlaps.length > 0 ? overlaps : closestCorners(args);
};

// Ghost Cell (see GLOSSARY.md), ADR-0011: a decorative, non-interactive
// overlay painted over cells no widget currently occupies, placed via exact
// grid-line coordinates (not auto-flow `span`) so it aligns pixel-for-pixel
// with real widgets. Rendered before real widgets in DOM order so it paints
// behind them; `pointer-events-none` keeps it out of every pointer
// interaction, drag/drop included.
function GhostCell({ row, col }: { row: number; col: number }) {
  return (
    <div
      data-testid="ghost-cell"
      aria-hidden="true"
      className="pointer-events-none rounded-md border border-dashed border-foreground/50"
      style={{ gridColumn: `${col} / span 1`, gridRow: `${row} / span 1` }}
    />
  );
}

function GhostCells({ items }: { items: GridItemSpan[] }) {
  const occupied = computeOccupiedCells(items);
  const rowCount = ghostGridRowCount(items);
  const cells: JSX.Element[] = [];
  for (let row = 1; row <= rowCount; row++) {
    for (let col = 1; col <= GRID_COLUMNS; col++) {
      if (!occupied.has(`${row},${col}`)) {
        cells.push(<GhostCell key={`${row},${col}`} row={row} col={col} />);
      }
    }
  }
  return <>{cells}</>;
}

function SortableGridItem({
  result,
  editMode,
  onChanged,
}: {
  result: WidgetLoadResult;
  editMode: boolean;
  onChanged: () => void;
}) {
  const id = resultKey(result);
  const span = resultSpan(result);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !editMode || result.status === 'error',
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        gridColumn: `span ${span.w}`,
        gridRow: `span ${span.h}`,
        transform: CSS.Transform.toString(transform) ?? undefined,
        transition,
        opacity: isDragging ? 0.4 : undefined,
      }}
    >
      <WidgetRenderer
        result={result}
        onChanged={onChanged}
        editMode={editMode}
        dragHandleProps={result.status === 'ok' ? { ...attributes, ...listeners } : undefined}
      />
    </div>
  );
}

export function DashboardGrid({ results, onChanged, editMode }: DashboardGridProps) {
  const isDesktop = useIsDesktopViewport();
  const activeId = useSignal<string | null>(null);
  const ordered = sortedResults(results);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  // Below the desktop breakpoint, or while this dashboard hasn't gone
  // through the 12-column path yet, w/h spans mean nothing — single-column
  // stack by order (design spec §4.1), no drag affordance at all (desktop-only).
  if (!isDesktop) {
    return (
      <div data-testid="dashboard-grid" className="flex flex-col gap-4 p-4">
        {ordered.map((result) => (
          <WidgetRenderer
            key={resultKey(result)}
            result={result}
            onChanged={onChanged}
            editMode={false}
          />
        ))}
      </div>
    );
  }

  function handleDragStart(event: DragStartEvent) {
    activeId.value = String(event.active.id);
  }

  async function handleDragEnd(event: DragEndEvent) {
    const movedId = String(event.active.id);
    activeId.value = null;
    if (!event.over) return;
    const targetId = String(event.over.id);
    if (movedId === targetId) return;
    try {
      const changed = await reorderWidget(DEFAULT_DASHBOARD_ID, movedId, targetId);
      patchDashboardWidgets(DEFAULT_DASHBOARD_ID, changed);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to reorder widgets');
    }
  }

  const activeResult = activeId.value
    ? ordered.find((r) => resultKey(r) === activeId.value)
    : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => (activeId.value = null)}
    >
      <SortableContext items={ordered.map(resultKey)} strategy={rectSortingStrategy}>
        <div
          data-testid="dashboard-grid"
          className="grid gap-4 p-4"
          style={{
            gridTemplateColumns: `repeat(${GRID_COLUMNS}, 1fr)`,
            gridAutoRows: `${GRID_ROW_HEIGHT_PX}px`,
            gridAutoFlow: 'row',
          }}
        >
          {editMode && (
            <GhostCells
              items={ordered.map((result, index) => ({ order: index, ...resultSpan(result) }))}
            />
          )}
          {ordered.map((result) => (
            <SortableGridItem
              key={resultKey(result)}
              result={result}
              editMode={editMode}
              onChanged={onChanged}
            />
          ))}
        </div>
      </SortableContext>
      <DragOverlay>
        {activeResult ? (
          <div style={{ width: 320 }}>
            <WidgetRenderer result={activeResult} onChanged={onChanged} editMode={false} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
