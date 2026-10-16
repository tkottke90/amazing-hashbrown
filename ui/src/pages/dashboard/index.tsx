import { Plus } from 'lucide-preact';
import { Layout } from '@/components/layout';
import { useTitle } from '@/hooks/use-title';
import { Button } from '@/components/ui/button';
import { DashboardGrid } from './dashboard-grid';
import { useDashboardWidgets } from './use-dashboard-widgets';
import { WidgetDrawer } from './widget-drawer';

// path prop is consumed by preact-iso's Router for route matching
export function DashboardView(_props: { path?: string }) {
  useTitle('Dashboard');
  const { widgets, loading, error, refresh } = useDashboardWidgets();

  return (
    <Layout>
      <div class="flex flex-col h-full overflow-y-auto">
        <div class="flex items-center justify-between px-6 pt-6 pb-4">
          <h1 class="text-xl font-semibold">Dashboard</h1>
          <WidgetDrawer
            mode="add"
            onSaved={refresh}
            trigger={
              <Button type="button" variant="outline" size="sm" data-testid="dashboard-add-widget">
                <Plus /> Add widget
              </Button>
            }
          />
        </div>
        {loading.value ? (
          <p class="px-6 text-sm text-muted-foreground">Loading…</p>
        ) : error.value ? (
          <p class="px-6 text-sm text-destructive">{error.value}</p>
        ) : (
          <DashboardGrid results={widgets.value} onChanged={refresh} />
        )}
      </div>
    </Layout>
  );
}
