import { fireEvent, render, screen } from '@testing-library/preact';

const mockRoute = jest.fn();
jest.mock('preact-iso', () => ({
  useLocation: () => ({ url: '/', path: '/', query: {}, route: mockRoute }),
}));

import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu';
import {
  FavoriteModelItems,
  FAVORITES_SETTINGS_PATH,
  type FavoriteModelItemsProps,
} from '@/components/favorite-model-items';

const FAVORITES = [
  { provider: 'do', model: 'llama3.3-70b' },
  { provider: 'local', model: 'qwen3:14b' },
];

// Menu items only render inside an open Radix menu.
function renderInOpenMenu(props: Partial<FavoriteModelItemsProps> = {}) {
  const onSelect = jest.fn();
  render(
    <DropdownMenu open>
      <DropdownMenuContent>
        <FavoriteModelItems favorites={FAVORITES} onSelect={onSelect} {...props} />
        <div>provider-entries</div>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  return { onSelect };
}

describe('FavoriteModelItems', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders nothing at all when there are no favorites, so the menu is unchanged for users who never set any [unit]', () => {
    renderInOpenMenu({ favorites: [] });
    expect(screen.queryByText('Favorites')).not.toBeInTheDocument();
    expect(screen.queryByText('Configure favorites…')).not.toBeInTheDocument();
  });

  it('lists each favorite labelled with both provider and model, since favorites span providers [unit]', () => {
    renderInOpenMenu();
    expect(screen.getByText('Favorites')).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: 'do / llama3.3-70b' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: 'local / qwen3:14b' })).toBeInTheDocument();
  });

  it('checks only the favorite matching the active provider and model [unit]', () => {
    renderInOpenMenu({ activeProvider: 'local', activeModel: 'qwen3:14b' });
    expect(screen.getByRole('menuitemcheckbox', { name: 'local / qwen3:14b' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('menuitemcheckbox', { name: 'do / llama3.3-70b' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('does not check a favorite when only the model id matches under another provider [unit]', () => {
    renderInOpenMenu({ activeProvider: 'other', activeModel: 'qwen3:14b' });
    expect(screen.getByRole('menuitemcheckbox', { name: 'local / qwen3:14b' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('selecting a favorite reports its provider and model [unit]', () => {
    const { onSelect } = renderInOpenMenu();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'do / llama3.3-70b' }));
    expect(onSelect).toHaveBeenCalledWith('do', 'llama3.3-70b');
  });

  it('"Configure favorites…" navigates to the Model providers settings page [unit]', () => {
    renderInOpenMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Configure favorites…' }));
    expect(mockRoute).toHaveBeenCalledWith(FAVORITES_SETTINGS_PATH);
    expect(FAVORITES_SETTINGS_PATH).toBe('/settings?section=model-providers');
  });
});
