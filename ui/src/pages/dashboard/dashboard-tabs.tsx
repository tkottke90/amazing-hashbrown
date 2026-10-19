import { Plus } from 'lucide-preact';
import { Button } from '@/components/ui/button';
import type { DashboardListEntry } from '@/services/dashboard-api';

interface DashboardTabsProps {
  dashboards: DashboardListEntry[];
  activeDashboardId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}

// One tab per Dashboard, in list order (creation order — see
// listDashboards()), plus a trailing "+" to create a new one. No
// drag-to-reorder (matches the design mockup) and no inline rename — Name
// is only editable via the Dashboard Settings panel.
export function DashboardTabs({
  dashboards,
  activeDashboardId,
  onSelect,
  onCreate,
}: DashboardTabsProps) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto" data-testid="dashboard-tabs">
      {dashboards.map((d) => (
        <button
          key={d.id}
          type="button"
          data-testid={`dashboard-tab-${d.id}`}
          aria-current={d.id === activeDashboardId ? 'page' : undefined}
          className={
            d.id === activeDashboardId
              ? 'border-b-2 border-primary px-3 py-2 text-sm font-medium text-foreground'
              : 'border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground'
          }
          onClick={() => onSelect(d.id)}
        >
          {d.name}
        </button>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        title="New dashboard"
        data-testid="dashboard-tab-create"
        onClick={onCreate}
      >
        <Plus />
      </Button>
    </div>
  );
}
