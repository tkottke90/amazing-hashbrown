import { useEffect } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { showToast } from '@/lib/toast';
import { RoleDrawer, type RoleSavePayload } from './role-drawer';
import {
  fetchRoles,
  createRole,
  patchRole,
  deleteRole,
  setDefaultRole,
  type Role,
} from '@/services/roles-api';

// No empty-state branch: the server guarantees at least one Role always
// exists (boot-time backfill, ADR-0050/ADR-0051) — this list is never
// actually empty in normal operation.
export function SubAgentRolesCard() {
  const roles = useSignal<Role[]>([]);
  const defaultRole = useSignal<string | null>(null);
  const loading = useSignal(true);
  const loadError = useSignal<string | null>(null);

  async function refresh() {
    const data = await fetchRoles();
    roles.value = data.roles;
    defaultRole.value = data.defaultRole;
  }

  useEffect(() => {
    refresh()
      .catch((err: unknown) => {
        loadError.value = err instanceof Error ? err.message : 'Failed to load Sub-Agent roles';
      })
      .finally(() => {
        loading.value = false;
      });
  }, []);

  async function handleSaveAdd(payload: RoleSavePayload) {
    await createRole(payload.name, {
      provider: payload.provider ?? undefined,
      model: payload.model ?? undefined,
      systemPrompt: payload.systemPrompt ?? undefined,
    });
    await refresh();
    showToast('success', `Role "${payload.name}" added`);
  }

  async function handleSaveEdit(originalName: string, payload: RoleSavePayload) {
    await patchRole(originalName, payload);
    await refresh();
    showToast('success', `Role "${payload.name}" updated`);
  }

  async function handleSetDefault(role: Role) {
    try {
      await setDefaultRole(role.name);
      await refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to set default role');
    }
  }

  async function handleRemove(role: Role) {
    if (!confirm(`Remove role "${role.name}"? This cannot be undone.`)) return;
    try {
      await deleteRole(role.name);
      await refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to remove role');
    }
  }

  if (loadError.value) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Sub-Agents</CardTitle>
        </CardHeader>
        <CardContent>
          <p class="text-sm text-destructive">{loadError.value}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader class="flex flex-row items-center justify-between">
        <CardTitle>Sub-Agents</CardTitle>
        <RoleDrawer
          mode="add"
          onSave={handleSaveAdd}
          trigger={
            <Button type="button" variant="outline" size="sm">
              Add role
            </Button>
          }
        />
      </CardHeader>
      <CardContent>
        {loading.value ? (
          <p class="py-4 text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ul class="divide-y divide-border">
            {roles.value.map((role) => {
              const isDefault = defaultRole.value === role.name;
              return (
                <li key={role.name} data-slot={`role-row-${role.name}`} class="flex flex-col gap-2 py-3">
                  <div class="flex items-center justify-between gap-3">
                    <div class="flex min-w-0 items-center gap-2">
                      <span data-slot="role-row-name" class="text-sm font-medium">
                        {role.name}
                      </span>
                      {isDefault && (
                        <span
                          data-slot="role-row-default-badge"
                          class="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
                        >
                          Default
                        </span>
                      )}
                    </div>
                    <div class="flex items-center gap-2">
                      {!isDefault && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleSetDefault(role)}
                        >
                          Make default
                        </Button>
                      )}
                      <RoleDrawer
                        mode="edit"
                        initial={role}
                        onSave={(payload) => handleSaveEdit(role.name, payload)}
                        trigger={
                          <Button type="button" variant="ghost" size="sm">
                            Edit
                          </Button>
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        class="text-destructive hover:text-destructive"
                        onClick={() => void handleRemove(role)}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                  <p class="text-xs text-muted-foreground">
                    {role.provider && role.model ? `${role.provider} / ${role.model}` : 'System default'}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
