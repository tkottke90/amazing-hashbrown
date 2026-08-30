import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { Modal, useDialog } from '@tkottke90/preact-dialog';
import { Label } from '@/components/ui/label';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ProviderModelPicker } from '@/components/provider-model-picker';
import { ScaledCostInput } from '@/components/ui/scaled-cost-input';
import type { Scale } from '@/components/ui/scale-toggle';
import { fetchProviders, providers } from '@/hooks/use-providers';
import type { JSX } from 'preact';

export interface CostEntry {
  inputPer1kTokens: number;
  inputScale: Scale;
  outputPer1kTokens: number;
  outputScale: Scale;
}

interface RateModalProps {
  mode: 'add' | 'edit';
  initial?: { modelKey: string; entry: CostEntry };
  /** Existing cost-rate keys, used in Add mode to filter out already-costed models. */
  costs: Record<string, CostEntry>;
  onSave: (modelKey: string, entry: CostEntry) => void;
  trigger: JSX.Element;
}

export function RateModal({ mode, initial, costs, onSave, trigger }: RateModalProps) {
  return (
    <Modal
      title={mode === 'add' ? 'Add rate' : 'Edit rate'}
      className="mx-auto my-16 max-w-md p-4"
      trigger={trigger}
    >
      <RateForm mode={mode} initial={initial} costs={costs} onSave={onSave} />
    </Modal>
  );
}

interface RateFormProps {
  mode: 'add' | 'edit';
  initial?: { modelKey: string; entry: CostEntry };
  costs: Record<string, CostEntry>;
  onSave: (modelKey: string, entry: CostEntry) => void;
}

function RateForm({ mode, initial, costs, onSave }: RateFormProps) {
  const { close } = useDialog();

  useEffect(() => {
    void fetchProviders();
  }, []);

  const modelKey = useSignal(initial?.modelKey ?? '');
  const inputPer1k = useSignal(initial?.entry.inputPer1kTokens ?? 0);
  const inputScale = useSignal<Scale>(initial?.entry.inputScale ?? '1k');
  const outputPer1k = useSignal(initial?.entry.outputPer1kTokens ?? 0);
  const outputScale = useSignal<Scale>(initial?.entry.outputScale ?? '1k');

  function handleSubmit(e: Event) {
    e.preventDefault();
    if (!modelKey.value) return;
    onSave(modelKey.value.trim(), {
      inputPer1kTokens: inputPer1k.value,
      inputScale: inputScale.value,
      outputPer1kTokens: outputPer1k.value,
      outputScale: outputScale.value,
    });
    close();
  }

  return (
    <form onSubmit={handleSubmit} class="mt-4 flex flex-col gap-4">
      <div class="space-y-1.5">
        <Label>Model</Label>
        {mode === 'edit' ? (
          <p class="text-sm font-medium">{initial?.modelKey}</p>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger
              className={buttonVariants({
                variant: 'outline',
                size: 'default',
                className: 'w-full justify-start',
              })}
            >
              {modelKey.value || 'Select provider/model…'}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <ProviderModelPicker
                providers={providers.value}
                onSelect={(provider, model) => {
                  modelKey.value = `${provider}/${model}`;
                }}
                isModelHidden={(provider, model) => `${provider}/${model}` in costs}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <ScaledCostInput
        id="rate-input"
        label="Input cost"
        per1kValue={inputPer1k.value}
        scale={inputScale.value}
        onChange={(v, s) => {
          inputPer1k.value = v;
          inputScale.value = s;
        }}
      />

      <ScaledCostInput
        id="rate-output"
        label="Output cost"
        per1kValue={outputPer1k.value}
        scale={outputScale.value}
        onChange={(v, s) => {
          outputPer1k.value = v;
          outputScale.value = s;
        }}
      />

      <div class="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => close()}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={mode === 'add' && !modelKey.value}>
          {mode === 'add' ? 'Add rate' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
