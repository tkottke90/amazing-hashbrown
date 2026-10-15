import { WidgetRenderer } from './widget-renderer';
import type { DashboardWidget } from './types';

interface DashboardGridProps {
  widgets: DashboardWidget[];
}

export function DashboardGrid({ widgets }: DashboardGridProps) {
  return (
    <div
      data-testid="dashboard-grid"
      class="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      {widgets.map((w) => (
        <WidgetRenderer key={w.id} widget={w} />
      ))}
    </div>
  );
}
