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

jest.mock('@/services/providers-api', () => ({
  listProviderModels: jest.fn().mockResolvedValue([]),
  revokeProviderToken: jest.fn(),
}));

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
import * as providersApi from '@/services/providers-api';
import { showToast } from '@/lib/toast';

const mockFetch = api.fetchSettingsSection as jest.MockedFunction<typeof api.fetchSettingsSection>;
const mockPatch = api.patchSettingsSection as jest.MockedFunction<typeof api.patchSettingsSection>;
const mockRevoke = providersApi.revokeProviderToken as jest.MockedFunction<
  typeof providersApi.revokeProviderToken
>;

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

  // Regression test: provider-modal.tsx's form has no fields for models[]
  // (that's the Model Settings panel's job), so editing a provider used to
  // silently drop its models[] on save — see
  // docs/superpowers/specs/2026-10-14-per-model-sampling-pricing-config-design.md's
  // Context section.
  it("preserves a provider's models[] when editing an unrelated field [unit]", async () => {
    mockFetch.mockResolvedValue({
      ...DEFAULT_DATA,
      providers: [
        {
          name: 'ollama',
          type: 'ollama' as const,
          defaultModel: 'llama3',
          models: [{ id: 'llama3', temperature: 0.8 }],
        },
        { name: 'openai', type: 'openai' as const, apiKey: '****' },
      ],
    });
    mockPatch.mockResolvedValue(DEFAULT_DATA);
    const { container } = await renderLoaded();

    // The mocked Dialog (test/__mocks__/preact-dialog.tsx) renders every
    // ProviderModal instance's form unconditionally, so the Add form and
    // both rows' Edit forms are all in the DOM at once, sharing the same
    // field ids — scope to the ollama row's own <li> (which nests its Edit
    // form inline, same as its trigger button) via its data-slot, since
    // "ollama" as plain text also appears elsewhere (the row's own Type
    // select, the Default-provider picker).
    const rows = container.querySelectorAll('[data-slot="provider-row"]');
    const row = Array.from(rows).find((r) =>
      r.querySelector('[data-slot="provider-row-name"]')?.textContent?.includes('ollama'),
    ) as HTMLElement;
    // getByLabelText resolves a label's `for` via document.getElementById,
    // which (with the Add form's identically-id'd field also in the
    // document) can resolve to a field outside `row` entirely — a plain
    // attribute selector scoped to `row` sidesteps that.
    const baseUrlInput = row.querySelector('#provider-baseUrl') as HTMLInputElement;
    fireEvent.input(baseUrlInput, { target: { value: 'http://localhost:9999' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }));

    fireEvent.click(await screen.findByText('Save changes'));

    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
    const [, body] = mockPatch.mock.calls[0]!;
    const providers = (body as { providers: Array<{ name: string; models?: unknown[] }> })
      .providers;
    expect(providers.find((p) => p.name === 'ollama')?.models).toEqual([
      { id: 'llama3', temperature: 0.8 },
    ]);
  });

  it('shows empty state when no providers', async () => {
    mockFetch.mockResolvedValue({ providers: [], defaultProvider: '' });
    render(<ModelProvidersPanel />);
    await waitFor(() => expect(screen.getByText(/No providers configured/)).toBeInTheDocument());
  });

  describe('context budget (agent-behavior section composed into this page)', () => {
    const AGENT_BEHAVIOR_DATA = { chat: { contextWindow: { maxTokens: 32000 } } };

    beforeEach(() => {
      mockFetch.mockImplementation((slug: string) =>
        Promise.resolve(slug === 'agent-behavior' ? AGENT_BEHAVIOR_DATA : DEFAULT_DATA),
      );
    });

    it('renders the current maxTokens value from the agent-behavior section', async () => {
      await renderLoaded();
      const input = screen.getByLabelText('Context budget (tokens)') as HTMLInputElement;
      expect(input.value).toBe('32000');
    });

    it('saving sends two separate PATCHes — model-providers first, then agent-behavior with the new maxTokens', async () => {
      mockPatch.mockImplementation((slug: string) =>
        Promise.resolve(slug === 'agent-behavior' ? AGENT_BEHAVIOR_DATA : DEFAULT_DATA),
      );
      await renderLoaded();

      const input = screen.getByLabelText('Context budget (tokens)') as HTMLInputElement;
      fireEvent.input(input, { target: { value: '50000' } });
      fireEvent.click(await screen.findByText('Save changes'));

      await waitFor(() => expect(mockPatch.mock.calls.length).toBe(2));
      expect(mockPatch.mock.calls[0]![0]).toBe('model-providers');
      expect(mockPatch.mock.calls[1]![0]).toBe('agent-behavior');
      const agentBehaviorBody = mockPatch.mock.calls[1]![1] as {
        chat: { contextWindow: { maxTokens: number } };
      };
      expect(agentBehaviorBody.chat.contextWindow.maxTokens).toBe(50000);
    });
  });

  describe('Azure OpenAI provider', () => {
    const AZURE_PROVIDER = {
      name: 'azure',
      type: 'azure-openai' as const,
      endpoint: 'https://my-resource.openai.azure.com',
      deploymentName: 'gpt-4o',
      apiVersion: '2024-10-21',
      auth: {
        tokenUrl: 'https://login.example.com/token',
        clientId: 'id',
        clientSecret: '****',
        grantType: 'client_credentials',
      },
    };

    const originalConfirm = global.confirm;
    afterEach(() => {
      global.confirm = originalConfirm;
    });

    it('renders the Azure OpenAI type badge and shows deploymentName in place of defaultModel [unit]', async () => {
      mockFetch.mockResolvedValue({ ...DEFAULT_DATA, providers: [AZURE_PROVIDER] });
      await renderLoaded();
      expect(screen.getAllByText('Azure OpenAI')[0]).toBeInTheDocument();
      expect(screen.getAllByText('gpt-4o')[0]).toBeInTheDocument();
    });

    it('shows a Revoke token button only for an azure-openai provider row [unit]', async () => {
      mockFetch.mockResolvedValue({
        ...DEFAULT_DATA,
        providers: [...DEFAULT_DATA.providers, AZURE_PROVIDER],
      });
      await renderLoaded();
      expect(screen.getAllByRole('button', { name: 'Revoke token' })).toHaveLength(1);
    });

    it('calls revokeProviderToken and shows a success toast after confirming [unit]', async () => {
      global.confirm = jest.fn(() => true);
      mockRevoke.mockResolvedValue(undefined);
      mockFetch.mockResolvedValue({ ...DEFAULT_DATA, providers: [AZURE_PROVIDER] });
      await renderLoaded();

      fireEvent.click(screen.getByRole('button', { name: 'Revoke token' }));

      await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith('azure'));
      expect(showToast).toHaveBeenCalledWith('success', 'Token revoked');
    });

    it('does not call revokeProviderToken when the confirm dialog is declined [unit]', async () => {
      global.confirm = jest.fn(() => false);
      mockFetch.mockResolvedValue({ ...DEFAULT_DATA, providers: [AZURE_PROVIDER] });
      await renderLoaded();

      fireEvent.click(screen.getByRole('button', { name: 'Revoke token' }));

      expect(mockRevoke).not.toHaveBeenCalled();
    });

    it('shows an error toast when revoking fails [unit]', async () => {
      global.confirm = jest.fn(() => true);
      mockRevoke.mockRejectedValue(new Error('Azure OpenAI provider "azure" not found.'));
      mockFetch.mockResolvedValue({ ...DEFAULT_DATA, providers: [AZURE_PROVIDER] });
      await renderLoaded();

      fireEvent.click(screen.getByRole('button', { name: 'Revoke token' }));

      await waitFor(() =>
        expect(showToast).toHaveBeenCalledWith('error', 'Azure OpenAI provider "azure" not found.'),
      );
    });

    it("preserves an azure-openai provider's auth/headers when editing an unrelated field [unit]", async () => {
      mockFetch.mockResolvedValue({ ...DEFAULT_DATA, providers: [AZURE_PROVIDER] });
      mockPatch.mockResolvedValue(DEFAULT_DATA);
      const { container } = await renderLoaded();

      const rows = container.querySelectorAll('[data-slot="provider-row"]');
      const row = Array.from(rows).find((r) =>
        r.querySelector('[data-slot="provider-row-name"]')?.textContent?.includes('azure'),
      ) as HTMLElement;
      const endpointInput = row.querySelector('#provider-endpoint') as HTMLInputElement;
      fireEvent.input(endpointInput, { target: { value: 'https://changed.openai.azure.com' } });
      fireEvent.click(within(row).getByRole('button', { name: 'Save' }));

      fireEvent.click(await screen.findByText('Save changes'));

      await waitFor(() => expect(mockPatch).toHaveBeenCalled());
      const [, body] = mockPatch.mock.calls[0]!;
      const providers = (
        body as { providers: Array<{ name: string; auth?: { clientId: string } }> }
      ).providers;
      expect(providers.find((p) => p.name === 'azure')?.auth?.clientId).toEqual('id');
    });
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
