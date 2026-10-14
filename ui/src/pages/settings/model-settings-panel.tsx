import { useEffect } from 'preact/hooks';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { fetchProviders, providers } from '@/hooks/use-providers';
import { useTitle } from '@/hooks/use-title';
import { useSettingsSection } from './use-settings-section';
import { SaveDiscardBar } from './save-discard-bar';
import { FieldError } from './field-error';
import { ModelEntryModal, type ModelSettingsRow } from './model-entry-modal';

interface ModelSettingsSettings {
  models: ModelSettingsRow[];
  legacyCosts: string[];
}

function rowKey(row: Pick<ModelSettingsRow, 'provider' | 'modelId'>): string {
  return `${row.provider}/${row.modelId}`;
}

export function ModelSettingsPanel() {
  useTitle('Settings - Model settings');
  const { form, isDirty, isSaving, fetchError, fieldErrors, setField, save, discard } =
    useSettingsSection<ModelSettingsSettings>('model-settings');

  useEffect(() => {
    void fetchProviders();
  }, []);

  if (fetchError.value) {
    return <div class="p-6 text-sm text-destructive">{fetchError.value}</div>;
  }

  if (!form.value) {
    return <div class="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  const models = form.value.models ?? [];
  const legacyCosts = form.value.legacyCosts ?? [];
  const existingKeys = new Set(models.map(rowKey));

  function handleAddModel(row: ModelSettingsRow) {
    setField('models', [...models, row]);
  }

  function handleEditModel(index: number, row: ModelSettingsRow) {
    setField(
      'models',
      models.map((existing, i) => (i === index ? row : existing)),
    );
  }

  function handleDeleteModel(index: number) {
    setField(
      'models',
      models.filter((_, i) => i !== index),
    );
  }

  return (
    <div class="flex min-h-full flex-col">
      <div class="flex-1 space-y-6 p-6">
        {legacyCosts.length > 0 && (
          <div class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
            <p class="font-medium">Legacy cost entries no longer used for pricing</p>
            <p class="mt-1 text-xs">
              Move these into a model below to keep its cost estimates accurate:{' '}
              {legacyCosts.join(', ')}
            </p>
          </div>
        )}

        <Card>
          <CardHeader class="flex flex-row items-center justify-between">
            <CardTitle>Model settings</CardTitle>
            <ModelEntryModal
              mode="add"
              existingKeys={existingKeys}
              onSave={handleAddModel}
              trigger={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={providers.value.length === 0}
                >
                  {providers.value.length === 0 ? 'No providers available' : 'Add model'}
                </Button>
              }
            />
          </CardHeader>
          <CardContent>
            {models.length === 0 ? (
              <div class="py-8 text-center">
                <p class="text-sm text-muted-foreground">No models configured.</p>
                <p class="mt-1 text-xs text-muted-foreground">
                  Add a model to set its pricing or override its sampling settings.
                </p>
              </div>
            ) : (
              <ul class="divide-y divide-border">
                {models.map((row, i) => (
                  <li key={rowKey(row)} class="flex items-center justify-between gap-3 py-3">
                    <div class="min-w-0">
                      <p class="truncate text-sm font-medium">{rowKey(row)}</p>
                      <p class="text-xs text-muted-foreground">
                        In: ${row.inputPricePerM ?? 0}/1M · Out: ${row.outputPricePerM ?? 0}/1M
                      </p>
                    </div>
                    <div class="flex items-center gap-1.5">
                      <ModelEntryModal
                        mode="edit"
                        initial={row}
                        existingKeys={existingKeys}
                        onSave={(updated) => handleEditModel(i, updated)}
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
                        onClick={() => handleDeleteModel(i)}
                      >
                        Delete
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <FieldError errors={fieldErrors.value['models']} />
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
