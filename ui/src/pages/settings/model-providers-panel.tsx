import { useEffect } from 'preact/hooks';
import { Trash2 } from 'lucide-preact';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTitle } from '@/hooks/use-title';
import { useSettingsSection } from './use-settings-section';
import { SaveDiscardBar } from './save-discard-bar';
import { FieldError } from './field-error';
import { ProviderModal, type ProviderConfig } from './provider-modal';
import { FormLayout } from '@/components/form-layout';
import {
  fetchProviders,
  invalidateProviders,
  providers as liveProviders,
  type FavoriteModel,
} from '@/hooks/use-providers';
import { FavoriteModelModal } from './favorite-model-modal';

interface ModelProvidersSettings {
  providers: ProviderConfig[];
  defaultProvider: string;
  favoriteModels: FavoriteModel[];
}

const TYPE_LABELS: Record<string, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

export function ModelProvidersPanel() {
  useTitle('Settings - Model providers');
  const { form, isDirty, isSaving, fetchError, fieldErrors, setField, save, discard } =
    useSettingsSection<ModelProvidersSettings>('model-providers');

  // Live model lists (GET /api/v1/providers) — power the Add-favorite picker
  // and the Unavailable badge on favorites that no longer resolve.
  useEffect(() => {
    void fetchProviders();
  }, []);

  if (fetchError.value) {
    return <div class="p-6 text-sm text-destructive">{fetchError.value}</div>;
  }

  if (!form.value) {
    return <div class="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  const providers = form.value.providers ?? [];
  const defaultProvider = form.value.defaultProvider ?? '';
  const favorites = form.value.favoriteModels ?? [];
  const live = liveProviders.value;

  // Only judged once the live list has loaded — before that, every
  // favorite would falsely read as unavailable.
  function isUnavailable(f: FavoriteModel): boolean {
    if (live.length === 0) return false;
    const provider = live.find((p) => p.name === f.provider);
    return !provider?.models.some((m) => m.id === f.model);
  }

  function handleAddFavorite(f: FavoriteModel) {
    setField('favoriteModels', [...favorites, f]);
  }

  function handleRemoveFavorite(index: number) {
    setField(
      'favoriteModels',
      favorites.filter((_, i) => i !== index),
    );
  }

  async function handleSave() {
    await save();
    // Chat reads favorites from the cached /api/v1/providers response —
    // drop the cache so the change shows up there without the 60s wait.
    invalidateProviders();
  }

  function handleAddProvider(p: ProviderConfig) {
    setField('providers', [...providers, p]);
  }

  function handleEditProvider(index: number, p: ProviderConfig) {
    const updated = providers.map((existing, i) => (i === index ? p : existing));
    setField('providers', updated);
  }

  return (
    <div class="flex min-h-full flex-col">
      <div class="flex-1 space-y-6 p-6">
        <Card>
          <CardHeader class="flex flex-row items-center justify-between">
            <CardTitle>Providers</CardTitle>
            <ProviderModal
              mode="add"
              onSave={handleAddProvider}
              trigger={
                <Button type="button" variant="outline" size="sm">
                  Add provider
                </Button>
              }
            />
          </CardHeader>
          <CardContent>
            {providers.length === 0 ? (
              <p class="py-4 text-center text-sm text-muted-foreground">
                No providers configured. Add one to get started.
              </p>
            ) : (
              <ul class="divide-y divide-border">
                {providers.map((p, i) => (
                  <li
                    key={p.name}
                    data-slot="provider-row"
                    class="flex items-center justify-between gap-3 py-3"
                  >
                    <div class="flex min-w-0 items-center gap-2">
                      <span data-slot="provider-row-name" class="font-medium text-sm">
                        {p.name}
                      </span>
                      <span class="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
                        {TYPE_LABELS[p.type] ?? p.type}
                      </span>
                      {p.name === defaultProvider && (
                        <span class="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">
                          Default
                        </span>
                      )}
                      {p.defaultModel && (
                        <span class="truncate text-xs text-muted-foreground">{p.defaultModel}</span>
                      )}
                    </div>
                    <ProviderModal
                      mode="edit"
                      initial={p}
                      onSave={(updated) => handleEditProvider(i, updated)}
                      trigger={
                        <Button type="button" variant="ghost" size="sm">
                          Edit
                        </Button>
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
            <FieldError errors={fieldErrors.value['providers']} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader class="flex flex-row items-center justify-between">
            <CardTitle>Favorites</CardTitle>
            <FavoriteModelModal
              favorites={favorites}
              onSave={handleAddFavorite}
              trigger={
                <Button type="button" variant="outline" size="sm" disabled={live.length === 0}>
                  {live.length === 0 ? 'No providers available' : 'Add favorite'}
                </Button>
              }
            />
          </CardHeader>
          <CardContent>
            {favorites.length === 0 ? (
              <p class="py-4 text-center text-sm text-muted-foreground">
                No favorite models. Add one to pin it to the top of the chat model menu.
              </p>
            ) : (
              <ul class="divide-y divide-border">
                {favorites.map((f, i) => (
                  <li
                    key={`${f.provider}/${f.model}`}
                    data-slot="favorite-row"
                    class="flex items-center justify-between gap-3 py-3"
                  >
                    <div class="flex min-w-0 items-center gap-2">
                      <span
                        class="truncate text-sm font-medium"
                        title={`${f.provider} / ${f.model}`}
                      >
                        {f.provider} / {f.model}
                      </span>
                      {isUnavailable(f) && (
                        <span
                          class="shrink-0 rounded border border-destructive/40 px-1.5 py-0.5 text-xs text-destructive"
                          title="Not in this provider's current model list"
                        >
                          Unavailable
                        </span>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      class="text-destructive hover:text-destructive"
                      aria-label={`Remove ${f.provider} / ${f.model}`}
                      onClick={() => handleRemoveFavorite(i)}
                    >
                      <Trash2 class="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <FieldError errors={fieldErrors.value['favoriteModels']} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Default provider</CardTitle>
          </CardHeader>
          <CardContent class="space-y-1.5">
            <FormLayout>
              <div class="space-y-1.5">
                <Label htmlFor="model-providers-default">Default provider</Label>
                <Select
                  value={defaultProvider}
                  onValueChange={(v) => setField('defaultProvider', v)}
                >
                  <SelectTrigger id="model-providers-default">
                    <SelectValue placeholder="Select a provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.name} value={p.name}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError errors={fieldErrors.value['defaultProvider']} />
              </div>
            </FormLayout>
          </CardContent>
        </Card>
      </div>

      <SaveDiscardBar
        isDirty={isDirty.value}
        isSaving={isSaving.value}
        onSave={handleSave}
        onDiscard={discard}
      />
    </div>
  );
}
