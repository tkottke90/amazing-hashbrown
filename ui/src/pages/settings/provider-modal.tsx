import { useSignal, type Signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { Dialog, useDialog } from '@tkottke90/preact-dialog';
import { Loader2, RefreshCw } from 'lucide-preact';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { listProviderModels } from '@/services/providers-api';
import type { JSX } from 'preact';

export interface ProviderConfig {
  name: string;
  type: 'ollama' | 'openai' | 'anthropic';
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
}

interface ProviderModalProps {
  mode: 'add' | 'edit';
  initial?: ProviderConfig;
  onSave: (p: ProviderConfig) => void;
  trigger: JSX.Element;
}

export function ProviderModal({ mode, initial, onSave, trigger }: ProviderModalProps) {
  // ProviderForm stays mounted across open/close (dialog children aren't
  // unmounted when hidden — see components/AGENTS.md), so it can't rely on
  // a mount-only effect to auto-load models on every open. Incrementing
  // this on each open gives it something to key an effect off of.
  const openCount = useSignal(0);

  return (
    <Dialog
      title={mode === 'add' ? 'Add provider' : 'Edit provider'}
      className="mx-auto my-16 max-w-lg p-4"
      trigger={trigger}
      onOpen={() => {
        openCount.value++;
      }}
    >
      <ProviderForm mode={mode} initial={initial} onSave={onSave} openCount={openCount} />
    </Dialog>
  );
}

interface ProviderFormProps {
  mode: 'add' | 'edit';
  initial?: ProviderConfig;
  onSave: (p: ProviderConfig) => void;
  openCount: Signal<number>;
}

function ProviderForm({ mode, initial, onSave, openCount }: ProviderFormProps) {
  const { close } = useDialog();

  const name = useSignal(initial?.name ?? '');
  const type = useSignal<'ollama' | 'openai' | 'anthropic'>(initial?.type ?? 'ollama');
  const baseUrl = useSignal(initial?.baseUrl ?? '');
  const apiKey = useSignal(initial?.apiKey ?? '');
  const defaultModel = useSignal(initial?.defaultModel ?? '');

  const models = useSignal<string[]>([]);
  const modelsLoading = useSignal(false);
  const modelsError = useSignal<string | null>(null);

  async function loadModels() {
    if (type.value !== 'anthropic' && !baseUrl.value.trim()) {
      modelsError.value = 'Base URL is required to list models.';
      return;
    }
    modelsLoading.value = true;
    modelsError.value = null;
    try {
      models.value = await listProviderModels({
        type: type.value,
        baseUrl: baseUrl.value.trim() || undefined,
        apiKey: apiKey.value || undefined,
        name: mode === 'edit' ? initial?.name : undefined,
      });
    } catch (err) {
      modelsError.value = err instanceof Error ? err.message : 'Failed to load models.';
    } finally {
      modelsLoading.value = false;
    }
  }

  // Fires once at mount (harmless: for "add", baseUrl starts empty so
  // loadModels bails out immediately; for "edit" it's a useful pre-load)
  // and again each time the dialog is reopened.
  const openedAt = openCount.value;
  useEffect(() => {
    void loadModels();
  }, [openedAt]);

  function handleSubmit(e: Event) {
    e.preventDefault();
    onSave({
      name: name.value.trim(),
      type: type.value,
      baseUrl: baseUrl.value.trim() || undefined,
      apiKey: apiKey.value || undefined,
      defaultModel: defaultModel.value.trim() || undefined,
    });
    close();
  }

  return (
    <form onSubmit={handleSubmit} class="mt-4 flex flex-col gap-4">
      <div class="space-y-1.5">
        <Label htmlFor="provider-name">Name</Label>
        <Input
          id="provider-name"
          value={name.value}
          onInput={(e) => (name.value = (e.target as HTMLInputElement).value)}
          disabled={mode === 'edit'}
          required
        />
      </div>

      <div class="space-y-1.5">
        <Label htmlFor="provider-type">Type</Label>
        <Select
          value={type.value}
          onValueChange={(v) => {
            type.value = v as typeof type.value;
            // Stale model names from the previous type don't apply here —
            // clear them out rather than leave them selectable until the
            // next manual/auto refresh.
            models.value = [];
            modelsError.value = null;
          }}
        >
          <SelectTrigger id="provider-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ollama">ollama</SelectItem>
            <SelectItem value="openai">openai</SelectItem>
            <SelectItem value="anthropic">anthropic</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="space-y-1.5">
        <Label htmlFor="provider-baseUrl">Base URL</Label>
        <Input
          id="provider-baseUrl"
          value={baseUrl.value}
          onInput={(e) => (baseUrl.value = (e.target as HTMLInputElement).value)}
          placeholder="https://api.example.com/v1"
        />
      </div>

      <div class="space-y-1.5">
        <Label htmlFor="provider-apiKey">API key</Label>
        <Input
          id="provider-apiKey"
          type="password"
          value={apiKey.value}
          onInput={(e) => (apiKey.value = (e.target as HTMLInputElement).value)}
          placeholder={mode === 'edit' ? 'Leave blank to keep unchanged' : ''}
        />
      </div>

      <div class="space-y-1.5">
        <Label htmlFor="provider-defaultModel">Default model</Label>
        <div class="flex gap-2">
          <Select value={defaultModel.value} onValueChange={(v) => (defaultModel.value = v)}>
            <SelectTrigger id="provider-defaultModel" class="flex-1">
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
            <SelectContent>
              {/* Preserve an existing value the fetched list doesn't (yet, or
                  no longer) contain — e.g. before the first load completes,
                  or if the model was removed from the provider — so the
                  field doesn't silently blank out an already-saved default. */}
              {defaultModel.value && !models.value.includes(defaultModel.value) && (
                <SelectItem value={defaultModel.value}>{defaultModel.value}</SelectItem>
              )}
              {models.value.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => void loadModels()}
            disabled={modelsLoading.value}
            title="Refresh model list"
          >
            {modelsLoading.value ? (
              <Loader2 class="size-4 animate-spin" />
            ) : (
              <RefreshCw class="size-4" />
            )}
          </Button>
        </div>
        <p class="empty:hidden text-xs text-destructive">{modelsError.value}</p>
      </div>

      <div class="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => close()}>
          Cancel
        </Button>
        <Button type="submit" size="sm">
          {mode === 'add' ? 'Add provider' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
