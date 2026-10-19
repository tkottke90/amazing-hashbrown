import { Trash2 } from 'lucide-preact';
import { Button } from '@/components/ui/button';
import { showToast } from '@/lib/toast';
import { deleteWidget } from '@/services/dashboard-api';
import { WidgetCard, type DragHandleProps } from './widget-card';
import { WidgetHeader } from './widget-header';
import { WidgetAction } from './widget-action';
import type { SpacerWidget as SpacerWidgetData } from '@tkottke90/amazing-hashbrown-widgets/types';

interface SpacerWidgetProps {
  widget: SpacerWidgetData;
  dashboardId: string;
  density: 'compact' | 'roomy';
  onChanged: () => void;
  editMode?: boolean;
  dragHandleProps?: DragHandleProps;
  w?: number;
  h?: number;
  minW?: number;
  minH?: number;
  onResize?: (w: number, h: number) => void;
}

// Spacer Widget (see GLOSSARY.md) — pure whitespace, no title/subtitle/
// provenance chrome. Invisible outside Edit Mode: renders nothing (the
// grid-item wrapper in dashboard-grid.tsx still reserves the cell via its
// own gridColumn/gridRow span styling regardless of what this renders). In
// Edit Mode: a generic label + drag grip + the resize handle WidgetCard
// already provides, plus a Delete button — there's no drawer, nothing else
// to edit — reusing WidgetAction the same way every other widget type
// deletes through it, rather than a one-off affordance.
export function SpacerWidget({
  widget,
  dashboardId,
  density,
  onChanged,
  editMode,
  dragHandleProps,
  w,
  h,
  minW,
  minH,
  onResize,
}: SpacerWidgetProps) {
  if (!editMode) return null;

  async function handleDelete() {
    if (!confirm(`Remove widget "${widget.title}"? This cannot be undone.`)) return;
    try {
      await deleteWidget(dashboardId, widget.id);
      onChanged();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to remove widget');
    }
  }

  return (
    <WidgetCard
      editMode={editMode}
      w={w}
      h={h}
      minW={minW}
      minH={minH}
      density={density}
      onResize={onResize}
    >
      <WidgetHeader title={widget.title} editMode={editMode} dragHandleProps={dragHandleProps} />
      <WidgetAction>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid="widget-delete-button"
          title="Delete widget"
          onClick={handleDelete}
        >
          <Trash2 />
        </Button>
      </WidgetAction>
    </WidgetCard>
  );
}
