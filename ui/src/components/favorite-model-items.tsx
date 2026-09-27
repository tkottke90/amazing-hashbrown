import { useLocation } from 'preact-iso';
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import type { FavoriteModel } from '@/hooks/use-providers';

export const FAVORITES_SETTINGS_PATH = '/settings?section=model-providers';

export interface FavoriteModelItemsProps {
  favorites: FavoriteModel[];
  activeProvider?: string;
  activeModel?: string;
  onSelect: (provider: string, model: string) => void;
}

// Flat "Favorites" section rendered at the top of the chat input's Provider
// sub-menu (issue #137). Deliberately plain items rather than another nested
// Sub — nesting is what required all the controlled-open/grace-timer
// handling in provider-model-picker.tsx (issues #113/#130), and flat items
// work on mobile without the bottom sheet. Renders nothing when there are no
// favorites; the feature is discovered from Settings.
export function FavoriteModelItems({
  favorites,
  activeProvider,
  activeModel,
  onSelect,
}: FavoriteModelItemsProps) {
  const { route } = useLocation();

  if (favorites.length === 0) return null;

  return (
    <>
      <DropdownMenuLabel className="text-xs text-muted-foreground">Favorites</DropdownMenuLabel>
      {favorites.map((f) => {
        const label = `${f.provider} / ${f.model}`;
        return (
          <DropdownMenuCheckboxItem
            key={`${f.provider}/${f.model}`}
            checked={f.provider === activeProvider && f.model === activeModel}
            onSelect={() => onSelect(f.provider, f.model)}
            title={label}
          >
            <span class="max-w-72 truncate">{label}</span>
          </DropdownMenuCheckboxItem>
        );
      })}
      <DropdownMenuItem onSelect={() => route(FAVORITES_SETTINGS_PATH)}>
        Configure favorites…
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}
