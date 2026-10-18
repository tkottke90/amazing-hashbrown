import { Pencil, Trash2 } from 'lucide-preact';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { showToast } from '@/lib/toast';
import { deleteWidget, DEFAULT_DASHBOARD_ID } from '@/services/dashboard-api';
import { WidgetCard, type DragHandleProps } from './widget-card';
import { WidgetDrawer } from './widget-drawer';
import type { SystemWidget as SystemWidgetData } from '@tkottke90/amazing-hashbrown-widgets/types';

interface SystemWidgetProps {
  widget: SystemWidgetData;
  onChanged: () => void;
  editMode?: boolean;
  dragHandleProps?: DragHandleProps;
  w?: number;
  h?: number;
  minW?: number;
  minH?: number;
  onResize?: (w: number, h: number) => void;
}

// Presentation only — this component never computes a value itself. It
// just switches on whatever the GET handler already resolved
// (widget.resolved, ADR-0011) and shows a dash while that's undefined
// (not yet resolved, an unknown metric id, or a resolver that threw).
function SystemWidgetValue({ widget }: { widget: SystemWidgetData }) {
  if (widget.resolved === undefined) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }
  switch (widget.resolved.displayType) {
    case 'big-number':
      return (
        <div data-testid="system-widget-value" className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold text-foreground">
            {widget.resolved.value === undefined ? 'N/A' : widget.resolved.value.toLocaleString()}
          </span>
          {widget.resolved.unit && (
            <span className="text-sm text-muted-foreground">{widget.resolved.unit}</span>
          )}
        </div>
      );
    case 'markdown':
      return (
        <div data-testid="system-widget-value">
          <Markdown>{widget.resolved.content}</Markdown>
        </div>
      );
    // Pie/Line Graph Metrics don't exist yet (follow-up issues #326/#328) —
    // no renderer for them here until one does.
    case 'pie-graph':
    case 'line-graph':
      return <span className="text-sm text-muted-foreground">—</span>;
  }
}

// Edit/delete controls live here, matching every other widget component —
// per ADR-0011/0013, a System Widget's own metric/title/subtitle are
// editable (through the drawer's Metric picker, never its Form/Raw
// editor), only the resolved value itself isn't.
export function SystemWidget({
  widget,
  onChanged,
  editMode,
  dragHandleProps,
  w,
  h,
  minW,
  minH,
  onResize,
}: SystemWidgetProps) {
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
      updatedAt={widget.updatedAt}
      editMode={editMode}
      dragHandleProps={dragHandleProps}
      w={w}
      h={h}
      minW={minW}
      minH={minH}
      onResize={onResize}
    >
      <SystemWidgetValue widget={widget} />
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
