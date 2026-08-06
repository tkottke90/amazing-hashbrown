import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useSettingsSection } from './use-settings-section';
import { SaveDiscardBar } from './save-discard-bar';
import { FieldError } from './field-error';

interface EmbeddingsSettings {
  enabled: boolean;
  type: 'ollama' | 'openai';
  model: string;
  baseUrl: string;
  apiKey?: string;
}

export function EmbeddingsPanel() {
  const { form, isDirty, isSaving, fetchError, fieldErrors, setField, save, discard } =
    useSettingsSection<EmbeddingsSettings>('embeddings');

  if (fetchError.value) {
    return <div class="p-6 text-sm text-destructive">{fetchError.value}</div>;
  }

  if (!form.value) {
    return <div class="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  const enabled = form.value.enabled;

  return (
    <div class="flex min-h-full flex-col">
      <div class="flex-1 space-y-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle>Embeddings</CardTitle>
          </CardHeader>
          <CardContent class="space-y-4">
            <div class="flex items-center justify-between">
              <div>
                <Label htmlFor="embeddings-enabled">Enable embeddings</Label>
                <p class="text-xs text-muted-foreground">
                  Enable vector embedding generation for knowledge retrieval.
                </p>
              </div>
              <Switch
                id="embeddings-enabled"
                checked={enabled}
                onCheckedChange={(v) => setField('enabled', v)}
              />
            </div>

            {enabled && (
              <>
                <div class="space-y-1.5">
                  <Label htmlFor="embeddings-type">Type</Label>
                  <Select value={form.value.type} onValueChange={(v) => setField('type', v)}>
                    <SelectTrigger id="embeddings-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ollama">ollama</SelectItem>
                      <SelectItem value="openai">openai</SelectItem>
                    </SelectContent>
                  </Select>
                  <FieldError errors={fieldErrors.value['type']} />
                </div>

                <div class="space-y-1.5">
                  <Label htmlFor="embeddings-model">Model</Label>
                  <Input
                    id="embeddings-model"
                    value={form.value.model}
                    onInput={(e) => setField('model', (e.target as HTMLInputElement).value)}
                  />
                  <FieldError errors={fieldErrors.value['model']} />
                </div>

                <div class="space-y-1.5">
                  <Label htmlFor="embeddings-baseUrl">Base URL</Label>
                  <Input
                    id="embeddings-baseUrl"
                    value={form.value.baseUrl}
                    onInput={(e) => setField('baseUrl', (e.target as HTMLInputElement).value)}
                  />
                  <FieldError errors={fieldErrors.value['baseUrl']} />
                </div>

                <div class="space-y-1.5">
                  <Label htmlFor="embeddings-apiKey">API key</Label>
                  <Input
                    id="embeddings-apiKey"
                    type="password"
                    value={form.value.apiKey ?? ''}
                    onInput={(e) => setField('apiKey', (e.target as HTMLInputElement).value)}
                    placeholder="Leave blank to keep unchanged"
                  />
                  <FieldError errors={fieldErrors.value['apiKey']} />
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <SaveDiscardBar
        isDirty={isDirty.value}
        isSaving={isSaving.value}
        onSave={save}
        onDiscard={discard}
      />
    </div>
  );
}
