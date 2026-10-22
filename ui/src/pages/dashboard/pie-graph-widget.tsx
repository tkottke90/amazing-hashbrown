import { Pencil, Trash2 } from 'lucide-preact';
import { Button } from '@/components/ui/button';
import { showToast } from '@/lib/toast';
import { deleteWidget } from '@/services/dashboard-api';
import { parseCsvBody } from './parse-csv-body';
import { PieChart } from './pie-chart';
import { WidgetCard, type DragHandleProps } from './widget-card';
import { WidgetHeader } from './widget-header';
import { WidgetContent } from './widget-content';
import { WidgetAction } from './widget-action';
import { WidgetFooter } from './widget-footer';
import { WidgetDrawer } from './widget-drawer';
import { WidgetCopyTargetButton } from './widget-copy-target-button';
import type { PieGraphWidget as PieGraphWidgetData } from '@tkottke90/amazing-hashbrown-widgets/types';

interface PieGraphWidgetProps {
  widget: PieGraphWidgetData;
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

export function PieGraphWidget({
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
}: PieGraphWidgetProps) {
  const { labels, values } = parseCsvBody(widget.data);

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
        <PieChart labels={labels} values={values} colors={widget.colors} />
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
        <WidgetCopyTargetButton
          dashboardId={dashboardId}
          widgetId={widget.id}
          widgetTitle={widget.title}
          widgetType={widget.type}
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
