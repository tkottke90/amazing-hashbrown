import { useSignal } from '@preact/signals';
import { Dialog, useDialog } from '@tkottke90/preact-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
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
  return (
    <Dialog
      title={mode === 'add' ? 'Add provider' : 'Edit provider'}
      className="mx-auto my-16 max-w-lg p-4"
      trigger={trigger}
    >
      <ProviderForm mode={mode} initial={initial} onSave={onSave} />
    </Dialog>
  );
}

interface ProviderFormProps {
  mode: 'add' | 'edit';
  initial?: ProviderConfig;
  onSave: (p: ProviderConfig) => void;
}

function ProviderForm({ mode, initial, onSave }: ProviderFormProps) {
  const { close } = useDialog();

  const name = useSignal(initial?.name ?? '');
  const type = useSignal<'ollama' | 'openai' | 'anthropic'>(initial?.type ?? 'ollama');
  const baseUrl = useSignal(initial?.baseUrl ?? '');
  const apiKey = useSignal(initial?.apiKey ?? '');
  const defaultModel = useSignal(initial?.defaultModel ?? '');

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
        <Select value={type.value} onValueChange={(v) => (type.value = v as typeof type.value)}>
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
        <Input
          id="provider-defaultModel"
          value={defaultModel.value}
          onInput={(e) => (defaultModel.value = (e.target as HTMLInputElement).value)}
        />
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
