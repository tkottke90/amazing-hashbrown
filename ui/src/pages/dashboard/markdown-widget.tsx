import { Pencil, Trash2 } from 'lucide-preact';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { showToast } from '@/lib/toast';
import { deleteWidget } from '@/services/dashboard-api';
import { WidgetCard, type DragHandleProps } from './widget-card';
import { WidgetHeader } from './widget-header';
import { WidgetContent } from './widget-content';
import { WidgetAction } from './widget-action';
import { WidgetFooter } from './widget-footer';
import { WidgetDrawer } from './widget-drawer';
import type { MarkdownWidget as MarkdownWidgetData } from '@tkottke90/amazing-hashbrown-widgets/types';

interface MarkdownWidgetProps {
  widget: MarkdownWidgetData;
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

// Edit/delete controls live here, not in widget-card.tsx — per the design
// doc's D13, the shared card shell stays type-agnostic; only Markdown
// widgets are editable this slice.
export function MarkdownWidget({
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
}: MarkdownWidgetProps) {
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
      <WidgetHeader
        title={widget.title}
        subtitle={widget.subtitle}
        editMode={editMode}
        dragHandleProps={dragHandleProps}
      />
      <WidgetContent>
        <Markdown>{widget.content}</Markdown>
      </WidgetContent>
      <WidgetAction>
        <WidgetDrawer
          mode="edit"
          dashboardId={dashboardId}
          target={{ status: 'ok', widget }}
          onSaved={onChanged}
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-testid="widget-edit-button"
              title="Edit widget"
            >
              <Pencil />
            </Button>
          }
        />
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
      <WidgetFooter
        source={widget.source}
        maintainer={widget.maintainer}
        updatedAt={widget.updatedAt}
      />
    </WidgetCard>
  );
}
