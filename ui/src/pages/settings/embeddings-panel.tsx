import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-preact';
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
import { Button } from '@/components/ui/button';
import { useSettingsSection } from './use-settings-section';
import { SaveDiscardBar } from './save-discard-bar';
import { FieldError } from './field-error';
import { FormLayout } from '@/components/form-layout';
import { listProviderModels, testEmbeddings } from '@/services/providers-api';

type TestState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; dims: number; durationMs: number }
  | { status: 'error'; error: string };

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

  const models = useSignal<string[]>([]);
  const modelsLoading = useSignal(false);
  const modelsError = useSignal<string | null>(null);
  const hasAutoLoaded = useSignal(false);
  const testState = useSignal<TestState>({ status: 'idle' });

  async function loadModels() {
    if (!form.value) return;
    if (!form.value.baseUrl.trim()) {
      modelsError.value = 'Base URL is required to list models.';
      return;
    }
    modelsLoading.value = true;
    modelsError.value = null;
    try {
      models.value = await listProviderModels({
        type: form.value.type,
        baseUrl: form.value.baseUrl.trim(),
        apiKey: form.value.apiKey || undefined,
        source: 'embeddings',
        capability: 'embedding',
      });
    } catch (err) {
      modelsError.value = err instanceof Error ? err.message : 'Failed to load models.';
    } finally {
      modelsLoading.value = false;
    }
  }

  async function runTest() {
    if (!form.value?.model || !form.value.baseUrl) return;
    testState.value = { status: 'loading' };
    try {
      const result = await testEmbeddings({
        type: form.value.type,
        baseUrl: form.value.baseUrl.trim(),
        apiKey: form.value.apiKey || undefined,
        model: form.value.model,
      });
      testState.value = { status: 'success', dims: result.dims, durationMs: result.durationMs };
    } catch (err) {
      testState.value = {
        status: 'error',
        error: err instanceof Error ? err.message : 'Test failed.',
      };
    }
  }

  // Auto-loads once the section's settings arrive from the GET fetch (form
  // starts null), provided a base URL is already set — not on every field
  // edit afterward, hence the hasAutoLoaded guard: form.value is a new
  // object on every setField() call, so this effect (keyed off form.value)
  // re-runs on every keystroke, but only actually fetches the first time.
  useEffect(() => {
    if (hasAutoLoaded.value) return;
    if (!form.value?.baseUrl?.trim()) return;
    hasAutoLoaded.value = true;
    void loadModels();
  }, [form.value]);

  // Clear a stale test result whenever any form field changes.
  useEffect(() => {
    if (testState.value.status !== 'idle') {
      testState.value = { status: 'idle' };
    }
  }, [form.value]);

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
            <FormLayout>
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
                    <Select
                      value={form.value.type}
                      onValueChange={(v) => {
                        setField('type', v);
                        // Stale model names from the previous type don't
                        // apply here — clear them out rather than leave
                        // them selectable until the next refresh.
                        models.value = [];
                        modelsError.value = null;
                      }}
                    >
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

                  <div class="space-y-1.5">
                    <Label htmlFor="embeddings-model">Model</Label>
                    <div class="flex gap-2">
                      <Select value={form.value.model} onValueChange={(v) => setField('model', v)}>
                        <SelectTrigger id="embeddings-model" class="flex-1">
                          <SelectValue placeholder="Select a model" />
                        </SelectTrigger>
                        <SelectContent>
                          {/* Preserve an existing value the fetched list doesn't
                              (yet, or no longer) contain — e.g. before the first
                              load completes, or if the model was removed from
                              the provider — so the field never silently blanks
                              out an already-saved value. */}
                          {form.value.model && !models.value.includes(form.value.model) && (
                            <SelectItem value={form.value.model}>{form.value.model}</SelectItem>
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
                    <FieldError errors={fieldErrors.value['model']} />
                  </div>

                  <div class="flex items-center gap-3 pt-1">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void runTest()}
                      disabled={!form.value.model || testState.value.status === 'loading'}
                    >
                      {testState.value.status === 'loading' ? (
                        <>
                          <Loader2 class="mr-2 size-4 animate-spin" />
                          Testing…
                        </>
                      ) : (
                        'Test connection'
                      )}
                    </Button>

                    {testState.value.status === 'success' && (
                      <span class="flex items-center gap-1.5 text-sm text-green-600 dark:text-green-400">
                        <CheckCircle2 class="size-4 shrink-0" />
                        {testState.value.dims}-dim · {testState.value.durationMs}ms
                      </span>
                    )}

                    {testState.value.status === 'error' && (
                      <span class="flex items-center gap-1.5 text-sm text-destructive">
                        <XCircle class="size-4 shrink-0" />
                        {testState.value.error}
                      </span>
                    )}
                  </div>
                </>
              )}
            </FormLayout>
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
