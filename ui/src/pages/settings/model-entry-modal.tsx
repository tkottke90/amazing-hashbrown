import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { Modal, useDialog } from '@tkottke90/preact-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useProviderModelPicker } from '@/components/provider-model-picker';
import { ScaledCostInput } from '@/components/ui/scaled-cost-input';
import type { Scale } from '@/components/ui/scale-toggle';
import { fetchProviders, providers } from '@/hooks/use-providers';
import type { JSX } from 'preact';

// One configured providers[].models[] entry, flattened with its parent
// provider's identity — mirrors ModelSettingsEntry in
// api/src/routes/v1/settings.handlers.ts. `providerType` decides whether the
// Ollama-only sampling fields show; it's read-only here, never submitted.
export interface ModelSettingsRow {
  provider: string;
  providerType: string;
  modelId: string;
  inputPricePerM?: number;
  outputPricePerM?: number;
  temperature?: number;
  topP?: number;
  seed?: number;
  numCtx?: number;
  topK?: number;
  repeatPenalty?: number;
}

interface ModelEntryModalProps {
  mode: 'add' | 'edit';
  initial?: ModelSettingsRow;
  /** Existing `"provider/modelId"` keys, used in Add mode to filter out already-configured models. */
  existingKeys: Set<string>;
  onSave: (row: ModelSettingsRow) => void;
  trigger: JSX.Element;
}

export function ModelEntryModal({
  mode,
  initial,
  existingKeys,
  onSave,
  trigger,
}: ModelEntryModalProps) {
  return (
    <Modal
      title={mode === 'add' ? 'Add model' : 'Edit model'}
      className="mx-auto my-16 max-w-md p-4"
      trigger={trigger}
    >
      <ModelEntryForm mode={mode} initial={initial} existingKeys={existingKeys} onSave={onSave} />
    </Modal>
  );
}

interface ModelEntryFormProps {
  mode: 'add' | 'edit';
  initial?: ModelSettingsRow;
  existingKeys: Set<string>;
  onSave: (row: ModelSettingsRow) => void;
}

// A blank sampling field means "unset" (falls back to the provider default
// or the client's own default), never 0 — so these are kept as raw text and
// only parsed to a number (or left undefined) on submit, unlike the Pricing
// fields below which default to 0 like the old Cost Rates form did.
function parseOptionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : Number(trimmed);
}

function ModelEntryForm({ mode, initial, existingKeys, onSave }: ModelEntryFormProps) {
  const { close } = useDialog();

  useEffect(() => {
    void fetchProviders();
  }, []);

  const provider = useSignal(initial?.provider ?? '');
  const modelId = useSignal(initial?.modelId ?? '');

  const inputPricePerM = useSignal(initial?.inputPricePerM ?? 0);
  const inputScale = useSignal<Scale>('1M');
  const outputPricePerM = useSignal(initial?.outputPricePerM ?? 0);
  const outputScale = useSignal<Scale>('1M');

  const temperature = useSignal(initial?.temperature?.toString() ?? '');
  const topP = useSignal(initial?.topP?.toString() ?? '');
  const seed = useSignal(initial?.seed?.toString() ?? '');
  const numCtx = useSignal(initial?.numCtx?.toString() ?? '');
  const topK = useSignal(initial?.topK?.toString() ?? '');
  const repeatPenalty = useSignal(initial?.repeatPenalty?.toString() ?? '');

  const { items: providerModelItems, sheet: providerModelSheet } = useProviderModelPicker({
    providers: providers.value,
    onSelect: (p, m) => {
      provider.value = p;
      modelId.value = m;
    },
    isModelHidden: (p, m) => existingKeys.has(`${p}/${m}`),
  });

  // The Ollama-only sampling fields (numCtx/topK/repeatPenalty) only make
  // sense for an Ollama provider — in edit mode the row already carries its
  // provider's type; in add mode, look it up from the live list once a
  // provider has been picked.
  const providerType =
    mode === 'edit'
      ? initial?.providerType
      : providers.value.find((p) => p.name === provider.value)?.type;
  const isOllama = providerType === 'ollama';

  function handleSubmit(e: Event) {
    e.preventDefault();
    if (!provider.value || !modelId.value) return;
    onSave({
      provider: provider.value,
      providerType: providerType ?? '',
      modelId: modelId.value,
      inputPricePerM: inputPricePerM.value,
      outputPricePerM: outputPricePerM.value,
      temperature: parseOptionalNumber(temperature.value),
      topP: parseOptionalNumber(topP.value),
      seed: parseOptionalNumber(seed.value),
      ...(isOllama
        ? {
            numCtx: parseOptionalNumber(numCtx.value),
            topK: parseOptionalNumber(topK.value),
            repeatPenalty: parseOptionalNumber(repeatPenalty.value),
          }
        : {}),
    });
    close();
  }

  return (
    <form onSubmit={handleSubmit} class="mt-4 flex flex-col gap-4">
      <div class="space-y-1.5">
        <Label>Model</Label>
        {mode === 'edit' ? (
          <p class="text-sm font-medium">
            {initial?.provider} / {initial?.modelId}
          </p>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger
              className={buttonVariants({
                variant: 'outline',
                size: 'default',
                className: 'w-full justify-start',
              })}
            >
              {provider.value && modelId.value
                ? `${provider.value} / ${modelId.value}`
                : 'Select provider/model…'}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">{providerModelItems}</DropdownMenuContent>
          </DropdownMenu>
        )}
        {providerModelSheet}
      </div>

      <div class="space-y-2">
        <p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Pricing</p>
        <ScaledCostInput
          id="model-entry-input-price"
          label="Input cost"
          perMillionValue={inputPricePerM.value}
          scale={inputScale.value}
          onChange={(v, s) => {
            inputPricePerM.value = v;
            inputScale.value = s;
          }}
        />
        <ScaledCostInput
          id="model-entry-output-price"
          label="Output cost"
          perMillionValue={outputPricePerM.value}
          scale={outputScale.value}
          onChange={(v, s) => {
            outputPricePerM.value = v;
            outputScale.value = s;
          }}
        />
      </div>

      <div class="space-y-2">
        <p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Sampling</p>
        <div class="grid grid-cols-2 gap-2">
          <div class="space-y-1.5">
            <Label htmlFor="model-entry-temperature">Temperature</Label>
            <Input
              id="model-entry-temperature"
              type="number"
              step="any"
              placeholder="Provider default"
              value={temperature.value}
              onInput={(e) => (temperature.value = (e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="space-y-1.5">
            <Label htmlFor="model-entry-topp">Top P</Label>
            <Input
              id="model-entry-topp"
              type="number"
              step="any"
              placeholder="Provider default"
              value={topP.value}
              onInput={(e) => (topP.value = (e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="space-y-1.5">
            <Label htmlFor="model-entry-seed">Seed</Label>
            <Input
              id="model-entry-seed"
              type="number"
              step="1"
              placeholder="None"
              value={seed.value}
              onInput={(e) => (seed.value = (e.target as HTMLInputElement).value)}
            />
          </div>
          {isOllama && (
            <>
              <div class="space-y-1.5">
                <Label htmlFor="model-entry-numctx">Context size</Label>
                <Input
                  id="model-entry-numctx"
                  type="number"
                  step="1"
                  min="1"
                  placeholder="Provider default"
                  value={numCtx.value}
                  onInput={(e) => (numCtx.value = (e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="space-y-1.5">
                <Label htmlFor="model-entry-topk">Top K</Label>
                <Input
                  id="model-entry-topk"
                  type="number"
                  step="1"
                  min="1"
                  placeholder="Provider default"
                  value={topK.value}
                  onInput={(e) => (topK.value = (e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="space-y-1.5">
                <Label htmlFor="model-entry-repeatpenalty">Repeat penalty</Label>
                <Input
                  id="model-entry-repeatpenalty"
                  type="number"
                  step="any"
                  placeholder="Provider default"
                  value={repeatPenalty.value}
                  onInput={(e) => (repeatPenalty.value = (e.target as HTMLInputElement).value)}
                />
              </div>
            </>
          )}
        </div>
      </div>

      <div class="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => close()}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={mode === 'add' && !modelId.value}>
          {mode === 'add' ? 'Add model' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
