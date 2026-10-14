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

// ModelSettingsPanel/ModelEntryModal fetch the provider list to power the
// Add-model picker and to decide whether to show the Ollama-only sampling
// fields — mock the hook directly rather than letting fetchProviders() hit
// a real (unmocked) `fetch('/api/v1/providers')` in jsdom.
jest.mock('@/hooks/use-providers', () => ({
  providers: signal([
    { name: 'openai', type: 'openai', models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] },
    { name: 'local', type: 'ollama', models: [{ id: 'llama3' }] },
  ]),
  fetchProviders: jest.fn().mockResolvedValue(undefined),
}));

import { ModelSettingsPanel } from '@/pages/settings/model-settings-panel';
import * as api from '@/services/settings-api';

const mockFetch = api.fetchSettingsSection as jest.MockedFunction<typeof api.fetchSettingsSection>;

// jsdom has no `onpointerdown` IDL property — mirrors chat-input.test.tsx's
// helper, needed to open Radix's pointerdown-driven menus in tests.
function firePointerDown(element: Element) {
  fireEvent(element, new MouseEvent('PointerDown', { bubbles: true, cancelable: true, button: 0 }));
}

// Radix's DropdownMenuSubTrigger doesn't open on a bare pointerdown like the
// top-level DropdownMenuTrigger above — it opens on click, or on real
// pointer hover (timing-dependent), or an ArrowRight keypress while
// focused. Layer click + keyboard so this doesn't depend on which of
// those internal paths jsdom's synthetic events actually satisfy.
function openSubmenu(element: HTMLElement) {
  element.focus();
  fireEvent.click(element);
  fireEvent.keyDown(element, { key: 'ArrowRight' });
}

// The mocked Dialog (test/__mocks__/preact-dialog.tsx) always renders its
// children, so every row's Edit-mode ModelEntryModal — including its own
// read-only "{provider} / {modelId}" text — is present in the DOM alongside
// that row's own summary line, which renders similar text. Pick the first
// match explicitly rather than an unscoped getByText, which throws on the
// duplicate match.
function firstMatch(text: string): HTMLElement {
  return screen.getAllByText(text)[0]!;
}

describe('ModelSettingsPanel', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows empty state when no models are configured', async () => {
    mockFetch.mockResolvedValue({ models: [], legacyCosts: [] });
    render(<ModelSettingsPanel />);
    await waitFor(() => expect(screen.getByText(/No models configured/)).toBeInTheDocument());
  });

  it('renders rows with provider/model and per-million prices', async () => {
    mockFetch.mockResolvedValue({
      models: [
        {
          provider: 'openai',
          providerType: 'openai',
          modelId: 'gpt-4o',
          inputPricePerM: 5,
          outputPricePerM: 15,
        },
        {
          provider: 'openai',
          providerType: 'openai',
          modelId: 'gpt-4o-mini',
          inputPricePerM: 0.15,
          outputPricePerM: 0.6,
        },
      ],
      legacyCosts: [],
    });

    render(<ModelSettingsPanel />);
    await waitFor(() => expect(firstMatch('openai/gpt-4o')).toBeInTheDocument());

    expect(firstMatch('openai/gpt-4o-mini')).toBeInTheDocument();
    expect(screen.getByText(/In: \$5\/1M · Out: \$15\/1M/)).toBeInTheDocument();
    expect(screen.getByText(/In: \$0.15\/1M · Out: \$0.6\/1M/)).toBeInTheDocument();
  });

  it('shows the legacy-costs banner listing keys no longer used for pricing', async () => {
    mockFetch.mockResolvedValue({
      models: [],
      legacyCosts: ['anthropic/claude-sonnet-4-6', 'openai/gpt-4.1-mini'],
    });

    render(<ModelSettingsPanel />);
    await waitFor(() => expect(screen.getByText(/no longer used for pricing/)).toBeInTheDocument());
    expect(screen.getByText(/anthropic\/claude-sonnet-4-6/)).toBeInTheDocument();
    expect(screen.getByText(/openai\/gpt-4.1-mini/)).toBeInTheDocument();
  });

  it('does not show the legacy-costs banner when there are none', async () => {
    mockFetch.mockResolvedValue({ models: [], legacyCosts: [] });
    render(<ModelSettingsPanel />);
    await waitFor(() => expect(screen.getByText(/No models configured/)).toBeInTheDocument());
    expect(screen.queryByText(/no longer used for pricing/)).not.toBeInTheDocument();
  });

  it('delete button removes a row', async () => {
    mockFetch.mockResolvedValue({
      models: [{ provider: 'openai', providerType: 'openai', modelId: 'gpt-4o' }],
      legacyCosts: [],
    });

    render(<ModelSettingsPanel />);
    await waitFor(() => expect(firstMatch('openai/gpt-4o')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('openai/gpt-4o')).not.toBeInTheDocument());
    expect(screen.getByText('Save changes')).toBeInTheDocument();
  });

  it('renders Add model button', async () => {
    mockFetch.mockResolvedValue({ models: [], legacyCosts: [] });
    render(<ModelSettingsPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: 'Add model' })[0]).toBeInTheDocument();
  });

  it('adds a model via the provider/model picker and the pricing input', async () => {
    mockFetch.mockResolvedValue({ models: [], legacyCosts: [] });
    const { container } = render(<ModelSettingsPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    // The mocked Dialog (test/__mocks__/preact-dialog.tsx) always renders
    // both the trigger and the form content, so the Add-model form is
    // already present — no need to "open" it first.
    firePointerDown(screen.getByText('Select provider/model…'));
    openSubmenu(screen.getByText('openai'));
    fireEvent.click(screen.getByText('gpt-4o-mini'));

    // The input defaults to the 1M scale, so typing '5' means $5/1M directly
    // — no need to toggle the scale first.
    fireEvent.input(screen.getByLabelText('Input cost'), { target: { value: '5' } });

    const form = container.querySelector('form') as HTMLFormElement;
    fireEvent.click(within(form).getByRole('button', { name: 'Add model' }));

    await waitFor(() => expect(firstMatch('openai/gpt-4o-mini')).toBeInTheDocument());
    expect(screen.getByText(/In: \$5\/1M/)).toBeInTheDocument();
  });

  it("hides the Ollama-only sampling fields for a non-Ollama provider's model [unit]", async () => {
    mockFetch.mockResolvedValue({
      models: [{ provider: 'openai', providerType: 'openai', modelId: 'gpt-4o' }],
      legacyCosts: [],
    });
    render(<ModelSettingsPanel />);
    await waitFor(() => expect(firstMatch('openai/gpt-4o')).toBeInTheDocument());

    expect(screen.queryByLabelText('Context size')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Top K')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Repeat penalty')).not.toBeInTheDocument();
  });

  it("shows the Ollama-only sampling fields for an Ollama provider's model [unit]", async () => {
    mockFetch.mockResolvedValue({
      models: [{ provider: 'local', providerType: 'ollama', modelId: 'llama3' }],
      legacyCosts: [],
    });
    render(<ModelSettingsPanel />);
    await waitFor(() => expect(firstMatch('local/llama3')).toBeInTheDocument());

    expect(screen.getByLabelText('Context size')).toBeInTheDocument();
    expect(screen.getByLabelText('Top K')).toBeInTheDocument();
    expect(screen.getByLabelText('Repeat penalty')).toBeInTheDocument();
  });
});
