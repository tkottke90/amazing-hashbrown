import { useSignal } from '@preact/signals';
import { Modal, useDialog } from '@tkottke90/preact-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import type { JSX } from 'preact';

export interface CostEntry {
  inputPer1kTokens: number;
  outputPer1kTokens: number;
}

interface RateModalProps {
  mode: 'add' | 'edit';
  initial?: { modelKey: string; entry: CostEntry };
  onSave: (modelKey: string, entry: CostEntry) => void;
  trigger: JSX.Element;
}

export function RateModal({ mode, initial, onSave, trigger }: RateModalProps) {
  return (
    <Modal
      title={mode === 'add' ? 'Add rate' : 'Edit rate'}
      className="mx-auto my-16 max-w-md p-4"
      trigger={trigger}
    >
      <RateForm mode={mode} initial={initial} onSave={onSave} />
    </Modal>
  );
}

interface RateFormProps {
  mode: 'add' | 'edit';
  initial?: { modelKey: string; entry: CostEntry };
  onSave: (modelKey: string, entry: CostEntry) => void;
}

function RateForm({ mode, initial, onSave }: RateFormProps) {
  const { close } = useDialog();

  const modelKey = useSignal(initial?.modelKey ?? '');
  const inputPer1k = useSignal(String(initial?.entry.inputPer1kTokens ?? 0));
  const outputPer1k = useSignal(String(initial?.entry.outputPer1kTokens ?? 0));

  function handleSubmit(e: Event) {
    e.preventDefault();
    onSave(modelKey.value.trim(), {
      inputPer1kTokens: Number(inputPer1k.value),
      outputPer1kTokens: Number(outputPer1k.value),
    });
    close();
  }

  return (
    <form onSubmit={handleSubmit} class="mt-4 flex flex-col gap-4">
      <div class="space-y-1.5">
        <Label htmlFor="rate-modelKey">Model key</Label>
        <Input
          id="rate-modelKey"
          value={modelKey.value}
          onInput={(e) => (modelKey.value = (e.target as HTMLInputElement).value)}
          disabled={mode === 'edit'}
          required
          placeholder="e.g. gpt-4o"
        />
      </div>

      <div class="space-y-1.5">
        <Label htmlFor="rate-input">Input cost per 1k tokens ($)</Label>
        <Input
          id="rate-input"
          type="number"
          step="any"
          min="0"
          value={inputPer1k.value}
          onInput={(e) => (inputPer1k.value = (e.target as HTMLInputElement).value)}
          required
        />
      </div>

      <div class="space-y-1.5">
        <Label htmlFor="rate-output">Output cost per 1k tokens ($)</Label>
        <Input
          id="rate-output"
          type="number"
          step="any"
          min="0"
          value={outputPer1k.value}
          onInput={(e) => (outputPer1k.value = (e.target as HTMLInputElement).value)}
          required
        />
      </div>

      <div class="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => close()}>
          Cancel
        </Button>
        <Button type="submit" size="sm">
          {mode === 'add' ? 'Add rate' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
