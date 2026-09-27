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
import { useProviderModelPicker } from '@/components/provider-model-picker';
import { fetchProviders, providers, type FavoriteModel } from '@/hooks/use-providers';
import type { JSX } from 'preact';

interface FavoriteModelModalProps {
  /** Current (possibly unsaved) favorites — already-favorited pairs are hidden from the picker. */
  favorites: FavoriteModel[];
  onSave: (favorite: FavoriteModel) => void;
  trigger: JSX.Element;
}

// Add-only: changing a favorite is just remove + add, so there's no edit mode.
export function FavoriteModelModal({ favorites, onSave, trigger }: FavoriteModelModalProps) {
  return (
    <Modal title="Add favorite" className="mx-auto my-16 max-w-md p-4" trigger={trigger}>
      <FavoriteModelForm favorites={favorites} onSave={onSave} />
    </Modal>
  );
}

function FavoriteModelForm({ favorites, onSave }: Omit<FavoriteModelModalProps, 'trigger'>) {
  const { close } = useDialog();

  useEffect(() => {
    void fetchProviders();
  }, []);

  const selected = useSignal<FavoriteModel | null>(null);

  const { items: providerModelItems, sheet: providerModelSheet } = useProviderModelPicker({
    providers: providers.value,
    activeProvider: selected.value?.provider,
    activeModel: selected.value?.model,
    onSelect: (provider, model) => {
      selected.value = { provider, model };
    },
    isModelHidden: (provider, model) =>
      favorites.some((f) => f.provider === provider && f.model === model),
  });

  function handleSubmit(e: Event) {
    e.preventDefault();
    if (!selected.value) return;
    onSave(selected.value);
    selected.value = null;
    close();
  }

  return (
    <form onSubmit={handleSubmit} class="mt-4 flex flex-col gap-4">
      <div class="space-y-1.5">
        <Label>Model</Label>
        <DropdownMenu>
          <DropdownMenuTrigger
            className={buttonVariants({
              variant: 'outline',
              size: 'default',
              className: 'w-full justify-start',
            })}
          >
            <span class="truncate">
              {selected.value
                ? `${selected.value.provider} / ${selected.value.model}`
                : 'Select provider/model…'}
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">{providerModelItems}</DropdownMenuContent>
        </DropdownMenu>
        {providerModelSheet}
      </div>

      <div class="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => close()}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!selected.value}>
          Add favorite
        </Button>
      </div>
    </form>
  );
}
