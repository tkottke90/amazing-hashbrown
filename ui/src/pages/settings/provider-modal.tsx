import { useSignal, type Signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { Modal, useDialog } from '@tkottke90/preact-dialog';
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
import { KeyValueList } from '@/components/key-value-list';
import { listProviderModels } from '@/services/providers-api';
import type { JSX } from 'preact';

export interface ProviderConfig {
  name: string;
  type: 'ollama' | 'openai' | 'anthropic';
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  // Concurrent request slots the provider-queue gate allows for this
  // provider — -1 = unlimited (bypasses the gate). Undefined/unset defaults
  // to 1 server-side (see ProviderSchema in api/src/config/env.ts).
  maxConcurrency?: number;
  // Per-model pricing/sampling config (see ProviderSchema.models in
  // api/src/config/env.ts) — this modal never edits it (that's the Model
  // Settings panel's job), but must carry it through unchanged on save, or
  // editing any other field here would silently wipe it. Untyped here
  // deliberately: this modal has no reason to know its shape.
  models?: unknown[];
  // Static headers sent with every request this provider makes — applies to
  // every provider type, see GLOSSARY.md "Custom Headers".
  headers?: Record<string, string>;
}

// The Azure OpenAI Provider — a separate shape from ProviderConfig above,
// not more optional fields bolted onto it (see ADR-0024). OIDC is scoped to
// exactly this provider type; see GLOSSARY.md "Azure OpenAI Provider".
export interface AzureOpenAiProviderConfig {
  name: string;
  type: 'azure-openai';
  endpoint: string;
  deploymentName: string;
  apiVersion: string;
  auth: {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    scope?: string;
    grantType: string;
  };
  headers?: Record<string, string>;
  models?: unknown[];
}

export type AnyProviderConfig = ProviderConfig | AzureOpenAiProviderConfig;

interface ProviderModalProps {
  mode: 'add' | 'edit';
  initial?: AnyProviderConfig;
  onSave: (p: AnyProviderConfig) => void;
  trigger: JSX.Element;
}

export function ProviderModal({ mode, initial, onSave, trigger }: ProviderModalProps) {
  // ProviderForm stays mounted across open/close (dialog children aren't
  // unmounted when hidden — see components/AGENTS.md), so it can't rely on
  // a mount-only effect to auto-load models on every open. Incrementing
  // this on each open gives it something to key an effect off of.
  const openCount = useSignal(0);

  return (
    <Modal
      title={mode === 'add' ? 'Add provider' : 'Edit provider'}
      className="mx-auto my-16 max-w-lg p-4"
      trigger={trigger}
      onOpen={() => {
        openCount.value++;
      }}
    >
      <ProviderForm mode={mode} initial={initial} onSave={onSave} openCount={openCount} />
    </Modal>
  );
}

interface ProviderFormProps {
  mode: 'add' | 'edit';
  initial?: AnyProviderConfig;
  onSave: (p: AnyProviderConfig) => void;
  openCount: Signal<number>;
}

const initialAzure = (initial: AnyProviderConfig | undefined) =>
  initial?.type === 'azure-openai' ? initial : undefined;

function ProviderForm({ mode, initial, onSave, openCount }: ProviderFormProps) {
  const { close } = useDialog();

  const name = useSignal(initial?.name ?? '');
  const type = useSignal<AnyProviderConfig['type']>(initial?.type ?? 'ollama');
  const baseUrl = useSignal(initial?.type !== 'azure-openai' ? (initial?.baseUrl ?? '') : '');
  const apiKey = useSignal(initial?.type !== 'azure-openai' ? (initial?.apiKey ?? '') : '');
  const defaultModel = useSignal(
    initial?.type !== 'azure-openai' ? (initial?.defaultModel ?? '') : '',
  );
  const maxConcurrency = useSignal(
    (initial?.type !== 'azure-openai' ? initial?.maxConcurrency : undefined)?.toString() ?? '1',
  );
  const headers = useSignal<Record<string, string>>(initial?.headers ?? {});

  // Azure OpenAI Provider-only fields — see GLOSSARY.md "Azure OpenAI Provider".
  const endpoint = useSignal(initialAzure(initial)?.endpoint ?? '');
  const deploymentName = useSignal(initialAzure(initial)?.deploymentName ?? '');
  const apiVersion = useSignal(initialAzure(initial)?.apiVersion ?? '');
  const tokenUrl = useSignal(initialAzure(initial)?.auth.tokenUrl ?? '');
  const clientId = useSignal(initialAzure(initial)?.auth.clientId ?? '');
  const clientSecret = useSignal(initialAzure(initial)?.auth.clientSecret ?? '');
  const scope = useSignal(initialAzure(initial)?.auth.scope ?? '');

  const models = useSignal<string[]>([]);
  const modelsLoading = useSignal(false);
  const modelsError = useSignal<string | null>(null);

  async function loadModels() {
    // No live model listing for azure-openai — its Deployment Name is its
    // one "model", typed directly rather than picked from a fetched list
    // (see GLOSSARY.md "Deployment Name").
    if (type.value === 'azure-openai') return;
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
    if (type.value === 'azure-openai') {
      onSave({
        name: name.value.trim(),
        type: 'azure-openai',
        endpoint: endpoint.value.trim(),
        deploymentName: deploymentName.value.trim(),
        apiVersion: apiVersion.value.trim(),
        auth: {
          tokenUrl: tokenUrl.value.trim(),
          clientId: clientId.value.trim(),
          clientSecret: clientSecret.value || undefined,
          scope: scope.value.trim() || undefined,
          grantType: initialAzure(initial)?.auth.grantType ?? 'client_credentials',
        },
        headers: headers.value,
        // This form has no fields for it — carry the existing value through
        // unchanged so editing other fields here can't silently wipe it.
        models: initial?.models,
      });
      close();
      return;
    }
    onSave({
      name: name.value.trim(),
      type: type.value,
      baseUrl: baseUrl.value.trim() || undefined,
      apiKey: apiKey.value || undefined,
      defaultModel: defaultModel.value.trim() || undefined,
      maxConcurrency: Number(maxConcurrency.value) || 1,
      headers: headers.value,
      // This form has no fields for it — carry the existing value through
      // unchanged so editing any other field here can't silently wipe it.
      models: initial?.models,
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
            <SelectItem value="azure-openai">Azure OpenAI</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {type.value !== 'azure-openai' ? (
        <>
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
        </>
      ) : (
        <>
          <div class="space-y-1.5">
            <Label htmlFor="provider-endpoint">Endpoint</Label>
            <Input
              id="provider-endpoint"
              value={endpoint.value}
              onInput={(e) => (endpoint.value = (e.target as HTMLInputElement).value)}
              placeholder="https://my-resource.openai.azure.com"
              required
            />
          </div>

          <div class="space-y-1.5">
            <Label htmlFor="provider-deploymentName">Deployment name</Label>
            <Input
              id="provider-deploymentName"
              value={deploymentName.value}
              onInput={(e) => (deploymentName.value = (e.target as HTMLInputElement).value)}
              required
            />
          </div>

          <div class="space-y-1.5">
            <Label htmlFor="provider-apiVersion">API version</Label>
            <Input
              id="provider-apiVersion"
              value={apiVersion.value}
              onInput={(e) => (apiVersion.value = (e.target as HTMLInputElement).value)}
              placeholder="2024-10-21"
              required
            />
          </div>

          <div class="space-y-3 rounded-md border p-3">
            <p class="text-sm font-medium">Client Credentials</p>
            <div class="space-y-1.5">
              <Label htmlFor="provider-tokenUrl">Token URL</Label>
              <Input
                id="provider-tokenUrl"
                value={tokenUrl.value}
                onInput={(e) => (tokenUrl.value = (e.target as HTMLInputElement).value)}
                placeholder="https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token"
                required
              />
            </div>
            <div class="space-y-1.5">
              <Label htmlFor="provider-clientId">Client ID</Label>
              <Input
                id="provider-clientId"
                value={clientId.value}
                onInput={(e) => (clientId.value = (e.target as HTMLInputElement).value)}
                required
              />
            </div>
            <div class="space-y-1.5">
              <Label htmlFor="provider-clientSecret">Client secret</Label>
              <Input
                id="provider-clientSecret"
                type="password"
                value={clientSecret.value}
                onInput={(e) => (clientSecret.value = (e.target as HTMLInputElement).value)}
                placeholder={mode === 'edit' ? 'Leave blank to keep unchanged' : ''}
              />
            </div>
            <div class="space-y-1.5">
              <Label htmlFor="provider-scope">Scope</Label>
              <Input
                id="provider-scope"
                value={scope.value}
                onInput={(e) => (scope.value = (e.target as HTMLInputElement).value)}
                placeholder="https://cognitiveservices.azure.com/.default"
              />
            </div>
          </div>
        </>
      )}

      <div class="space-y-1.5">
        <Label>Custom headers</Label>
        <KeyValueList
          key={openedAt}
          value={headers.value}
          onChange={(next) => (headers.value = next)}
          keyPlaceholder="Header-Name"
          valuePlaceholder="value"
          addLabel="Add header"
        />
      </div>

      {type.value !== 'azure-openai' && (
        <div class="space-y-1.5">
          <Label htmlFor="provider-maxConcurrency">Max concurrent requests</Label>
          <Input
            id="provider-maxConcurrency"
            type="number"
            value={maxConcurrency.value}
            onInput={(e) => (maxConcurrency.value = (e.target as HTMLInputElement).value)}
          />
          <p class="mt-1 text-xs text-muted-foreground">
            How many requests may run against this provider at once. Local inference engines (e.g.
            Ollama) typically only handle 1 well. Use -1 for unlimited.
          </p>
        </div>
      )}

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
