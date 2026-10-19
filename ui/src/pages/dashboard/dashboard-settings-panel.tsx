import { useSignal, useComputed } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { JSX } from 'preact';
import { Drawer, useDialog } from '@tkottke90/preact-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { DensityToggle } from '@/components/ui/density-toggle';
import { useDashboards } from '@/hooks/use-dashboards';
import type { DashboardListEntry } from '@/services/dashboard-api';

interface DashboardSettingsPanelProps {
  dashboard: DashboardListEntry;
  trigger: JSX.Element;
}

// Reachable from view mode, not gated behind Edit Mode (D14) — renaming or
// describing a Dashboard is a metadata action, not a layout edit.
export function DashboardSettingsPanel({ dashboard, trigger }: DashboardSettingsPanelProps) {
  return (
    <Drawer title="Dashboard settings" side="right" trigger={trigger}>
      <DashboardSettingsForm dashboard={dashboard} />
    </Drawer>
  );
}

function DashboardSettingsForm({ dashboard }: { dashboard: DashboardListEntry }) {
  const { close } = useDialog();
  const { dashboards, updateDashboard, deleteDashboard } = useDashboards();

  const name = useSignal(dashboard.name);
  const description = useSignal(dashboard.description ?? '');
  const density = useSignal(dashboard.density);
  const isSaving = useSignal(false);
  const saveError = useSignal<string | null>(null);

  // Dialog children stay mounted between opens — re-seed from the current
  // dashboard on every open (and whenever a different dashboard's Settings
  // is opened), same pattern widget-drawer.tsx uses for its own form state.
  useEffect(() => {
    name.value = dashboard.name;
    description.value = dashboard.description ?? '';
    density.value = dashboard.density;
    saveError.value = null;
  }, [dashboard.id]);

  // D11's delete-guard — hidden, not disabled, when only one dashboard remains.
  const canDelete = useComputed(() => dashboards.value.length > 1);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    isSaving.value = true;
    saveError.value = null;
    try {
      await updateDashboard(dashboard.id, {
        name: name.value.trim(),
        description: description.value,
        density: density.value,
      });
      close();
    } catch (err) {
      saveError.value = err instanceof Error ? err.message : 'Failed to save dashboard';
    } finally {
      isSaving.value = false;
    }
  }

  function handleDelete() {
    if (!confirm(`Delete dashboard "${dashboard.name}"? This cannot be undone.`)) return;
    void deleteDashboard(dashboard.id).then(() => close());
  }

  return (
    <form
      data-testid="dashboard-settings-form"
      className="flex flex-col gap-4 p-4"
      onSubmit={handleSubmit}
    >
      <p className="text-sm text-muted-foreground">
        Metadata agents and system graphs read before writing to this dashboard.
      </p>

      <div className="flex flex-col gap-2">
        <Label htmlFor="dashboard-settings-name">Name</Label>
        <Input
          id="dashboard-settings-name"
          value={name.value}
          onInput={(e) => (name.value = (e.target as HTMLInputElement).value)}
          required
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="dashboard-settings-description">Description</Label>
        <Textarea
          id="dashboard-settings-description"
          placeholder="What belongs on this dashboard"
          value={description.value}
          onInput={(e) => (description.value = (e.target as HTMLTextAreaElement).value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label>Density</Label>
        <DensityToggle value={density.value} onChange={(v) => (density.value = v)} />
        <p className="text-xs text-muted-foreground">
          Compact packs more on screen; Roomy gives each widget more air.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Folder</Label>
        <Input value={dashboard.path} disabled readOnly data-testid="dashboard-settings-path" />
      </div>

      {saveError.value && <p className="text-sm text-destructive">{saveError.value}</p>}

      {canDelete.value && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start text-destructive hover:text-destructive"
          data-testid="dashboard-settings-delete"
          onClick={handleDelete}
        >
          Delete dashboard
        </Button>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => close()}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSaving.value}>
          {isSaving.value ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}
