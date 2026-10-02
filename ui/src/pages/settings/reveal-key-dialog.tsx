import type { Signal } from '@preact/signals';
import { useSignal } from '@preact/signals';
import { Check, Copy } from 'lucide-preact';
import { Modal, useDialog } from '@tkottke90/preact-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// Opens and closes entirely via the `open` signal — no visible trigger of
// its own, since it's shown as a side effect of a create/rotate call
// resolving, never from a click on this component. See Dialog.tsx: passing
// `open` with no `trigger` renders no default trigger button either.
export function RevealKeyDialog({
  open,
  apiKey,
}: {
  open: Signal<boolean>;
  apiKey: Signal<string | null>;
}) {
  return (
    <Modal title="Your new API key" open={open}>
      <RevealKeyContent apiKey={apiKey} />
    </Modal>
  );
}

function RevealKeyContent({ apiKey }: { apiKey: Signal<string | null> }) {
  const { close } = useDialog();
  const copied = useSignal(false);

  async function handleCopy() {
    if (!apiKey.value) return;
    await navigator.clipboard.writeText(apiKey.value);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1500);
  }

  return (
    <div class="flex flex-col gap-3 mt-4">
      <p class="text-sm text-muted-foreground">
        Copy this key now — you won't be able to see it again.
      </p>
      <div class="flex items-center gap-2">
        <Input
          readOnly
          data-testid="revealed-api-key"
          value={apiKey.value ?? ''}
          class="font-mono text-xs"
        />
        <Button
          type="button"
          variant="outline"
          size="xs"
          data-testid="revealed-api-key-copy-button"
          onClick={() => void handleCopy()}
        >
          {copied.value ? <Check class="size-3.5" /> : <Copy class="size-3.5" />}
        </Button>
      </div>
      <div class="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={() => close()}>
          Done
        </Button>
      </div>
    </div>
  );
}
