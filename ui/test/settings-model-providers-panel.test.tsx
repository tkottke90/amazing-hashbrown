import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { signal } from '@preact/signals';

jest.mock('@/services/settings-api', () => {
  class SettingsValidationError extends Error {
    fieldErrors: Record<string, string[]> | string;
    constructor(fe: Record<string, string[]> | string) {
      super('Validation failed');
      this.name = 'SettingsValidationError';
      this.fieldErrors = fe;
    }
  }
  return {
    SettingsValidationError,
    fetchSettingsSection: jest.fn(),
    patchSettingsSection: jest.fn(),
  };
});
jest.mock('@/lib/toast', () => ({ showToast: jest.fn() }));

// The panel and its Add-favorite modal read live model lists from this hook;
// mock it so nothing hits a real fetch('/api/v1/providers') in jsdom. Tests
// set `providers.value` to control what counts as "live".
jest.mock('@/hooks/use-providers', () => ({
  providers: signal([]),
  fetchProviders: jest.fn().mockResolvedValue(undefined),
  invalidateProviders: jest.fn(),
}));

import { ModelProvidersPanel } from '@/pages/settings/model-providers-panel';
import * as api from '@/services/settings-api';
import * as providersHook from '@/hooks/use-providers';

const mockFetch = api.fetchSettingsSection as jest.MockedFunction<typeof api.fetchSettingsSection>;
const mockPatch = api.patchSettingsSection as jest.MockedFunction<typeof api.patchSettingsSection>;

const LIVE_PROVIDERS = [
  { name: 'ollama', type: 'ollama', models: [{ id: 'llama3' }, { id: 'qwen3:14b' }] },
  { name: 'openai', type: 'openai', models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] },
];

// jsdom has no `onpointerdown` IDL property — same helper as
// settings-cost-rates-panel.test.tsx, needed to open Radix menus.
function firePointerDown(element: Element) {
  fireEvent(element, new MouseEvent('PointerDown', { bubbles: true, cancelable: true, button: 0 }));
}

function openSubmenu(element: HTMLElement) {
  element.focus();
  fireEvent.click(element);
  fireEvent.keyDown(element, { key: 'ArrowRight' });
}

// The mocked Dialog always renders its content, so the Add-favorite form is
// already in the DOM; locate it by its picker trigger.
function favoriteForm(): HTMLFormElement {
  return screen.getByText('Select provider/model…').closest('form') as HTMLFormElement;
}

async function renderLoaded() {
  const result = render(<ModelProvidersPanel />);
  await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
  return result;
}

const DEFAULT_DATA = {
  providers: [
    { name: 'ollama', type: 'ollama' as const, defaultModel: 'llama3' },
    { name: 'openai', type: 'openai' as const, apiKey: '****' },
  ],
  defaultProvider: 'ollama',
  favoriteModels: [] as Array<{ provider: string; model: string }>,
};

describe('ModelProvidersPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue(DEFAULT_DATA);
    providersHook.providers.value = LIVE_PROVIDERS;
  });

  it('renders provider rows with name and type badge', async () => {
    render(<ModelProvidersPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    expect(screen.getAllByText('ollama')[0]).toBeInTheDocument();
    expect(screen.getAllByText('openai')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Ollama').length).toBeGreaterThan(0);
    expect(screen.getAllByText('OpenAI').length).toBeGreaterThan(0);
  });

  it('shows Default badge on the default provider', async () => {
    render(<ModelProvidersPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
    expect(screen.getByText('Default')).toBeInTheDocument();
  });

  it('renders Add provider button', async () => {
    render(<ModelProvidersPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: 'Add provider' })[0]).toBeInTheDocument();
  });

  it('renders Edit button for each provider', async () => {
    render(<ModelProvidersPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2);
  });

  it('shows empty state when no providers', async () => {
    mockFetch.mockResolvedValue({ providers: [], defaultProvider: '' });
    render(<ModelProvidersPanel />);
    await waitFor(() => expect(screen.getByText(/No providers configured/)).toBeInTheDocument());
  });

  describe('Favorites card', () => {
    it('explains the empty state so users know what favorites are for [unit]', async () => {
      await renderLoaded();
      expect(screen.getByText(/No favorite models/)).toBeInTheDocument();
    });

    it('renders one row per saved favorite as "provider / model" [unit]', async () => {
      mockFetch.mockResolvedValue({
        ...DEFAULT_DATA,
        favoriteModels: [
          { provider: 'openai', model: 'gpt-4o' },
          { provider: 'ollama', model: 'llama3' },
        ],
      });
      const { container } = await renderLoaded();

      const rows = container.querySelectorAll('[data-slot="favorite-row"]');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveTextContent('openai / gpt-4o');
      expect(rows[1]).toHaveTextContent('ollama / llama3');
    });

    it('adds a favorite picked through the provider/model picker and marks the form dirty [unit]', async () => {
      const { container } = await renderLoaded();
      // Grab the form first: once a model is picked, the trigger's
      // "Select provider/model…" placeholder is replaced by the selection.
      const form = favoriteForm();

      firePointerDown(screen.getByText('Select provider/model…'));
      openSubmenu(screen.getByRole('menuitem', { name: 'openai' }));
      fireEvent.click(screen.getByText('gpt-4o-mini'));
      fireEvent.click(within(form).getByRole('button', { name: 'Add favorite' }));

      await waitFor(() =>
        expect(container.querySelector('[data-slot="favorite-row"]')).toHaveTextContent(
          'openai / gpt-4o-mini',
        ),
      );
      expect(screen.getByText('Save changes')).toBeInTheDocument();
    });

    it('keeps the add button disabled until a model is chosen [unit]', async () => {
      await renderLoaded();
      expect(within(favoriteForm()).getByRole('button', { name: 'Add favorite' })).toBeDisabled();
    });

    it('hides already-favorited pairs from the picker so duplicates cannot be added [unit]', async () => {
      mockFetch.mockResolvedValue({
        ...DEFAULT_DATA,
        favoriteModels: [{ provider: 'openai', model: 'gpt-4o' }],
      });
      await renderLoaded();

      firePointerDown(screen.getByText('Select provider/model…'));
      openSubmenu(screen.getByRole('menuitem', { name: 'openai' }));

      await waitFor(() => expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument());
      expect(screen.queryByRole('menuitemcheckbox', { name: 'gpt-4o' })).not.toBeInTheDocument();
    });

    it('removes a favorite via its labelled remove button [unit]', async () => {
      mockFetch.mockResolvedValue({
        ...DEFAULT_DATA,
        favoriteModels: [{ provider: 'openai', model: 'gpt-4o' }],
      });
      const { container } = await renderLoaded();

      fireEvent.click(screen.getByRole('button', { name: 'Remove openai / gpt-4o' }));

      await waitFor(() =>
        expect(container.querySelector('[data-slot="favorite-row"]')).not.toBeInTheDocument(),
      );
      expect(screen.getByText('Save changes')).toBeInTheDocument();
    });

    it('badges a favorite whose model is missing from the live list so stale entries are visible [unit]', async () => {
      mockFetch.mockResolvedValue({
        ...DEFAULT_DATA,
        favoriteModels: [
          { provider: 'openai', model: 'retired-model' },
          { provider: 'openai', model: 'gpt-4o' },
        ],
      });
      const { container } = await renderLoaded();

      const rows = container.querySelectorAll('[data-slot="favorite-row"]');
      expect(within(rows[0] as HTMLElement).getByText('Unavailable')).toBeInTheDocument();
      expect(within(rows[1] as HTMLElement).queryByText('Unavailable')).not.toBeInTheDocument();
    });

    it('does not badge anything before the live list loads, avoiding a false "all unavailable" flash [unit]', async () => {
      providersHook.providers.value = [];
      mockFetch.mockResolvedValue({
        ...DEFAULT_DATA,
        favoriteModels: [{ provider: 'openai', model: 'gpt-4o' }],
      });
      await renderLoaded();

      expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
    });

    it('disables adding when no live providers are available [unit]', async () => {
      providersHook.providers.value = [];
      await renderLoaded();
      expect(screen.getByRole('button', { name: 'No providers available' })).toBeDisabled();
    });

    it('sends favoriteModels in the save request and refreshes the chat provider cache [orchestration]', async () => {
      mockFetch.mockResolvedValue({
        ...DEFAULT_DATA,
        favoriteModels: [
          { provider: 'openai', model: 'gpt-4o' },
          { provider: 'ollama', model: 'llama3' },
        ],
      });
      mockPatch.mockResolvedValue({
        ...DEFAULT_DATA,
        favoriteModels: [{ provider: 'ollama', model: 'llama3' }],
      });
      await renderLoaded();

      fireEvent.click(screen.getByRole('button', { name: 'Remove openai / gpt-4o' }));
      fireEvent.click(await screen.findByText('Save changes'));

      await waitFor(() => expect(providersHook.invalidateProviders).toHaveBeenCalled());
      expect(mockPatch).toHaveBeenCalledWith(
        'model-providers',
        expect.objectContaining({ favoriteModels: [{ provider: 'ollama', model: 'llama3' }] }),
      );
    });

    it('shows a backend validation error under the Favorites card [unit]', async () => {
      mockFetch.mockResolvedValue({
        ...DEFAULT_DATA,
        favoriteModels: [{ provider: 'gone', model: 'x' }],
      });
      mockPatch.mockRejectedValue(
        new api.SettingsValidationError({
          favoriteModels: ['Favorite "gone / x" references unknown provider "gone"'],
        }),
      );
      await renderLoaded();

      fireEvent.click(screen.getByRole('button', { name: 'Remove gone / x' }));
      fireEvent.click(await screen.findByText('Save changes'));

      await waitFor(() =>
        expect(screen.getByText(/references unknown provider "gone"/)).toBeInTheDocument(),
      );
    });
  });
});
