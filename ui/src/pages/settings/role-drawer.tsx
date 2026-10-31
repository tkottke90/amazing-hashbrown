import { useSignal, type Signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { Drawer, useDialog } from '@tkottke90/preact-dialog';
import { Loader2 } from 'lucide-preact';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useProviderModelPicker } from '@/components/provider-model-picker';
import { providers, fetchProviders } from '@/hooks/use-providers';
import type { Role, RolePatch } from '@/services/roles-api';
import type { JSX } from 'preact';

// Always carries a definite name/provider/model/systemPrompt by submit time
// (no field is ever omitted) — provider/model/systemPrompt use `null`
// explicitly for "cleared" vs a string for "set", matching RolePatch's
// tri-state contract; the card adapts this into a createRole (add) or
// patchRole (edit) call.
export type RoleSavePayload = { name: string } & Required<
  Pick<RolePatch, 'provider' | 'model' | 'systemPrompt'>
>;

interface RoleDrawerProps {
  mode: 'add' | 'edit';
  initial?: Role;
  onSave: (payload: RoleSavePayload) => Promise<void>;
  trigger: JSX.Element;
}

export function RoleDrawer({ mode, initial, onSave, trigger }: RoleDrawerProps) {
  // Re-open counter, same reason as mcp-server-drawer.tsx: dialog children
  // stay mounted between opens, so form state needs an explicit reset hook.
  const openCount = useSignal(0);

  return (
    <Drawer
      title={mode === 'add' ? 'Add role' : 'Edit role'}
      side="right"
      className="w-[90vw]! sm:w-md! sm:max-w-[90vw]! py-4"
      trigger={trigger}
      onOpen={() => {
        openCount.value++;
      }}
    >
      <RoleForm mode={mode} initial={initial} onSave={onSave} openCount={openCount} />
    </Drawer>
  );
}

interface RoleFormProps {
  mode: 'add' | 'edit';
  initial?: Role;
  onSave: RoleDrawerProps['onSave'];
  openCount: Signal<number>;
}

function RoleForm({ mode, initial, onSave, openCount }: RoleFormProps) {
  const { close } = useDialog();

  useEffect(() => {
    void fetchProviders();
  }, []);

  // Dialog children stay mounted at all times regardless of open state —
  // with one Add drawer plus one Edit drawer per row, every RoleForm
  // instance is simultaneously present in the DOM. Suffix every id with an
  // instance-unique key to avoid duplicate-id <label for> collisions.
  const instanceKey = mode === 'edit' && initial ? `edit-${initial.name}` : 'add';

  const name = useSignal(initial?.name ?? '');
  const provider = useSignal(initial?.provider ?? '');
  const model = useSignal(initial?.model ?? '');
  const systemPrompt = useSignal(initial?.systemPrompt ?? '');

  const isSaving = useSignal(false);
  const saveError = useSignal<string | null>(null);

  const openedAt = openCount.value;
  useEffect(() => {
    saveError.value = null;
  }, [openedAt]);

  const { items: providerModelItems, sheet: providerModelSheet } = useProviderModelPicker({
    providers: providers.value,
    activeProvider: provider.value || undefined,
    activeModel: model.value || undefined,
    onSelect: (p, m) => {
      provider.value = p;
      model.value = m;
    },
  });

  async function handleSubmit(e: Event) {
    e.preventDefault();
    isSaving.value = true;
    saveError.value = null;
    try {
      // Provider/model/systemPrompt always carry a definite value by submit
      // time — the picker (or "Use system default") already resolved it —
      // so these are always sent as either a string (set) or an explicit
      // `null` (cleared — inherit the system default), never omitted.
      const payload: RoleSavePayload = {
        name: name.value.trim(),
        provider: provider.value || null,
        model: model.value || null,
        systemPrompt: systemPrompt.value.trim() || null,
      };

      await onSave(payload);
      close();
    } catch (err) {
      saveError.value = err instanceof Error ? err.message : 'Failed to save';
    } finally {
      isSaving.value = false;
    }
  }

  return (
    <form onSubmit={handleSubmit} class="flex min-h-full flex-col">
      <div class="flex-1 space-y-4 overflow-y-auto p-4">
        <div class="space-y-1.5">
          <Label htmlFor={`role-name-${instanceKey}`}>Name</Label>
          <Input
            id={`role-name-${instanceKey}`}
            value={name.value}
            onInput={(e) => (name.value = (e.target as HTMLInputElement).value)}
            placeholder="code-reviewer"
            required
          />
          <p class="text-xs text-muted-foreground">
            Lowercase letters, digits and hyphens — the name the agent passes as <code>role</code>.
          </p>
        </div>

        <div class="space-y-1.5">
          <Label>Provider / Model</Label>
          <div class="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                className={buttonVariants({
                  variant: 'outline',
                  size: 'default',
                  className: 'w-full justify-start',
                })}
              >
                {provider.value && model.value
                  ? `${provider.value} / ${model.value}`
                  : 'System default'}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">{providerModelItems}</DropdownMenuContent>
            </DropdownMenu>
            {(provider.value || model.value) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  provider.value = '';
                  model.value = '';
                }}
              >
                Clear
              </Button>
            )}
          </div>
          {providerModelSheet}
          <p class="text-xs text-muted-foreground">
            Leave unset to inherit the system default provider/model.
          </p>
        </div>

        <div class="space-y-1.5">
          <Label htmlFor={`role-system-prompt-${instanceKey}`}>System prompt</Label>
          <Textarea
            id={`role-system-prompt-${instanceKey}`}
            rows={4}
            value={systemPrompt.value}
            onInput={(e) => (systemPrompt.value = (e.target as HTMLTextAreaElement).value)}
            placeholder="Optional — appended to this sub-agent's system prompt."
          />
        </div>

        {saveError.value && <p class="text-xs text-destructive">{saveError.value}</p>}
      </div>

      <div class="flex justify-end gap-2 border-t border-border px-3 py-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => close()}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={isSaving.value}>
          {isSaving.value && <Loader2 class="size-3.5 animate-spin" />}
          {mode === 'add' ? 'Add role' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
