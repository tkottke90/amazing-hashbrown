import { Pencil, Trash2 } from 'lucide-preact';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { showToast } from '@/lib/toast';
import { deleteWidget, DEFAULT_DASHBOARD_ID } from '@/services/dashboard-api';
import { WidgetCard, type DragHandleProps } from './widget-card';
import { WidgetDrawer } from './widget-drawer';
import type { MarkdownWidget as MarkdownWidgetData } from '@tkottke90/amazing-hashbrown-widgets/types';

interface MarkdownWidgetProps {
  widget: MarkdownWidgetData;
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
      await deleteWidget(DEFAULT_DASHBOARD_ID, widget.id);
      onChanged();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to remove widget');
    }
  }

  return (
    <WidgetCard
      title={widget.title}
      subtitle={widget.subtitle}
      source={widget.source}
      maintainer={widget.maintainer}
      updatedAt={widget.updatedAt}
      editMode={editMode}
      dragHandleProps={dragHandleProps}
      w={w}
      h={h}
      minW={minW}
      minH={minH}
      onResize={onResize}
    >
      <Markdown>{widget.content}</Markdown>
      <div className="flex justify-end gap-1">
        <WidgetDrawer
          mode="edit"
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
      </div>
    </WidgetCard>
  );
}
