import { useSignal } from '@preact/signals';
import { Pencil, Plus, Settings } from 'lucide-preact';
import { Layout } from '@/components/layout';
import { useTitle } from '@/hooks/use-title';
import { Button } from '@/components/ui/button';
import { DashboardGrid } from './dashboard-grid';
import { DashboardTabs } from './dashboard-tabs';
import { DashboardSettingsPanel } from './dashboard-settings-panel';
import { useDashboardWidgets } from '@/hooks/use-dashboard-widgets';
import { useDashboards } from '@/hooks/use-dashboards';
import { WidgetDrawer } from './widget-drawer';

// path prop is consumed by preact-iso's Router for route matching
export function DashboardView(_props: { path?: string }) {
  useTitle('Dashboard');

  const {
    dashboards,
    activeDashboardId,
    loading: dashboardsLoading,
    setActiveDashboardId,
    createDashboard,
  } = useDashboards();

  const activeId = activeDashboardId.value ?? '';
  const activeDashboard = dashboards.value.find((d) => d.id === activeId);

  const { widgets, loading, error, refresh } = useDashboardWidgets(activeId);
  // Edit Mode (see GLOSSARY.md) — purely client-side, never persisted; every
  // load starts false regardless of how the previous session left it.
  const editMode = useSignal(false);
  // D10: drives the widget-add drawer open with no visible trigger click,
  // right after a new dashboard is created.
  const addWidgetOpen = useSignal(false);

  async function handleCreateDashboard() {
    await createDashboard();
    editMode.value = true;
    addWidgetOpen.value = true;
  }

  if (dashboardsLoading.value || !activeDashboard) {
    return (
      <Layout>
        <p class="px-6 pt-6 text-sm text-muted-foreground">Loading…</p>
      </Layout>
    );
  }

  return (
    <Layout>
      <div class="flex flex-col h-full overflow-y-auto">
        <div class="flex items-center justify-between px-6 pt-6 pb-4">
          <DashboardTabs
            dashboards={dashboards.value}
            activeDashboardId={activeId}
            onSelect={setActiveDashboardId}
            onCreate={() => void handleCreateDashboard()}
          />
          <div class="flex items-center gap-2">
            <DashboardSettingsPanel
              dashboard={activeDashboard}
              trigger={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="dashboard-settings-trigger"
                >
                  <Settings /> Dashboard settings
                </Button>
              }
            />
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
              dashboardId={activeId}
              onSaved={refresh}
              open={addWidgetOpen}
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
        ) : widgets.value.length === 0 ? (
          <div class="px-6 text-center" data-testid="dashboard-empty-state">
            <h2 class="text-lg font-medium">New dashboard</h2>
            <p class="text-sm text-muted-foreground">
              Nothing here yet. Enter edit mode to add widgets.
            </p>
          </div>
        ) : (
          <DashboardGrid
            results={widgets.value}
            onChanged={refresh}
            editMode={editMode.value}
            dashboardId={activeId}
            density={activeDashboard.density}
          />
        )}
      </div>
    </Layout>
  );
}
