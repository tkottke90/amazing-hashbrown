import type { WidgetLoadResult } from '@tkottke90/amazing-hashbrown-widgets/types';
import { WidgetRenderer } from './widget-renderer';

interface DashboardGridProps {
  results: WidgetLoadResult[];
  onChanged: () => void;
}

function resultKey(result: WidgetLoadResult): string {
  return result.status === 'ok' ? result.widget.id : result.id;
}

export function DashboardGrid({ results, onChanged }: DashboardGridProps) {
  return (
    <div
      data-testid="dashboard-grid"
      class="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      {results.map((result) => (
        <WidgetRenderer key={resultKey(result)} result={result} onChanged={onChanged} />
      ))}
    </div>
  );
}
