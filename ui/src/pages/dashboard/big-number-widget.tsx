import { Pencil, Trash2 } from 'lucide-preact';
import { Button } from '@/components/ui/button';
import { showToast } from '@/lib/toast';
import { deleteWidget, DEFAULT_DASHBOARD_ID } from '@/services/dashboard-api';
import { WidgetCard } from './widget-card';
import { WidgetDrawer } from './widget-drawer';
import type { BigNumberWidget as BigNumberWidgetData } from '@tkottke90/amazing-hashbrown-widgets/types';

interface BigNumberWidgetProps {
  widget: BigNumberWidgetData;
  onChanged: () => void;
}

export function BigNumberWidget({ widget, onChanged }: BigNumberWidgetProps) {
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
    >
      <div data-testid="big-number-widget" className="flex items-baseline gap-2">
        <span className="text-3xl font-semibold text-foreground">
          {widget.value === undefined ? 'N/A' : widget.value.toLocaleString()}
        </span>
        {widget.unit && <span className="text-sm text-muted-foreground">{widget.unit}</span>}
      </div>
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
