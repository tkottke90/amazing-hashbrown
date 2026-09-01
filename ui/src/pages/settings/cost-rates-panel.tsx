import { useEffect } from 'preact/hooks';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { scaledDisplayValue } from '@/components/ui/scaled-cost-input';
import { fetchProviders, providers } from '@/hooks/use-providers';
import { useTitle } from '@/hooks/use-title';
import { useSettingsSection } from './use-settings-section';
import { SaveDiscardBar } from './save-discard-bar';
import { RateModal, type CostEntry } from './rate-modal';

interface CostRatesSettings {
  costs: Record<string, CostEntry>;
}

export function CostRatesPanel() {
  useTitle('Settings - Cost rates');
  const { form, isDirty, isSaving, fetchError, setField, save, discard } =
    useSettingsSection<CostRatesSettings>('cost-rates');

  useEffect(() => {
    void fetchProviders();
  }, []);

  if (fetchError.value) {
    return <div class="p-6 text-sm text-destructive">{fetchError.value}</div>;
  }

  if (!form.value) {
    return <div class="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  const costs = form.value.costs ?? {};
  const entries = Object.entries(costs);

  function handleAddRate(modelKey: string, entry: CostEntry) {
    setField('costs', { ...costs, [modelKey]: entry });
  }

  function handleEditRate(modelKey: string, entry: CostEntry) {
    setField('costs', { ...costs, [modelKey]: entry });
  }

  function handleDeleteRate(modelKey: string) {
    const updated = { ...costs };
    delete updated[modelKey];
    setField('costs', updated);
  }

  return (
    <div class="flex min-h-full flex-col">
      <div class="flex-1 space-y-6 p-6">
        <Card>
          <CardHeader class="flex flex-row items-center justify-between">
            <CardTitle>Cost rates</CardTitle>
            <RateModal
              mode="add"
              costs={costs}
              onSave={handleAddRate}
              trigger={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={providers.value.length === 0}
                >
                  {providers.value.length === 0 ? 'No providers available' : 'Add rate'}
                </Button>
              }
            />
          </CardHeader>
          <CardContent>
            {entries.length === 0 ? (
              <div class="py-8 text-center">
                <p class="text-sm text-muted-foreground">No cost rates configured.</p>
                <p class="mt-1 text-xs text-muted-foreground">
                  Add a rate to track usage costs by model.
                </p>
              </div>
            ) : (
              <ul class="divide-y divide-border">
                {entries.map(([modelKey, entry]) => (
                  <li key={modelKey} class="flex items-center justify-between gap-3 py-3">
                    <div class="min-w-0">
                      <p class="truncate text-sm font-medium">{modelKey}</p>
                      <p class="text-xs text-muted-foreground">
                        In: ${scaledDisplayValue(entry.inputPer1kTokens, entry.inputScale)}/
                        {entry.inputScale} · Out: $
                        {scaledDisplayValue(entry.outputPer1kTokens, entry.outputScale)}/
                        {entry.outputScale}
                      </p>
                    </div>
                    <div class="flex items-center gap-1.5">
                      <RateModal
                        mode="edit"
                        initial={{ modelKey, entry }}
                        costs={costs}
                        onSave={handleEditRate}
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
                        onClick={() => handleDeleteRate(modelKey)}
                      >
                        Delete
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
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
