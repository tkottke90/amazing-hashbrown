import { Layout } from '@/components/layout';
import { useTitle } from '@/hooks/use-title';
import { DashboardGrid } from './dashboard-grid';
import { useDashboardWidgets } from './use-dashboard-widgets';

// path prop is consumed by preact-iso's Router for route matching
export function DashboardView(_props: { path?: string }) {
  useTitle('Dashboard');
  const widgets = useDashboardWidgets();

  return (
    <Layout>
      <div class="flex flex-col h-full overflow-y-auto">
        <div class="px-6 pt-6 pb-4">
          <h1 class="text-xl font-semibold">Dashboard</h1>
        </div>
        <DashboardGrid widgets={widgets} />
      </div>
    </Layout>
  );
}
