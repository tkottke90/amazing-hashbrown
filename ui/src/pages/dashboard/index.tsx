import { useSignal } from '@preact/signals';
import { Pencil, Plus } from 'lucide-preact';
import { Layout } from '@/components/layout';
import { useTitle } from '@/hooks/use-title';
import { Button } from '@/components/ui/button';
import { DashboardGrid } from './dashboard-grid';
import { useDashboardWidgets } from '@/hooks/use-dashboard-widgets';
import { WidgetDrawer } from './widget-drawer';

// path prop is consumed by preact-iso's Router for route matching
export function DashboardView(_props: { path?: string }) {
  useTitle('Dashboard');
  const { widgets, loading, error, refresh } = useDashboardWidgets();
  // Edit Mode (see GLOSSARY.md) — purely client-side, never persisted; every
  // load starts false regardless of how the previous session left it.
  const editMode = useSignal(false);

  return (
    <Layout>
      <div class="flex flex-col h-full overflow-y-auto">
        <div class="flex items-center justify-between px-6 pt-6 pb-4">
          <h1 class="text-xl font-semibold">Dashboard</h1>
          <div class="flex items-center gap-2">
            <Button
              type="button"
              variant={editMode.value ? 'default' : 'outline'}
              size="sm"
              data-testid="dashboard-edit-mode-toggle"
              onClick={() => (editMode.value = !editMode.value)}
            >
              <Pencil /> {editMode.value ? 'Done editing' : 'Edit Dashboard'}
            </Button>
            <WidgetDrawer
              mode="add"
              onSaved={refresh}
              trigger={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="dashboard-add-widget"
                >
                  <Plus /> Add widget
                </Button>
              }
            />
          </div>
        </div>
        {loading.value ? (
          <p class="px-6 text-sm text-muted-foreground">Loading…</p>
        ) : error.value ? (
          <p class="px-6 text-sm text-destructive">{error.value}</p>
        ) : (
          <DashboardGrid results={widgets.value} onChanged={refresh} editMode={editMode.value} />
        )}
      </div>
    </Layout>
  );
}
