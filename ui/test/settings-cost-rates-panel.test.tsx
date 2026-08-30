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

// CostRatesPanel/RateModal now fetch the provider list to power the Add-rate
// picker — mock the hook directly rather than letting fetchProviders() hit
// a real (unmocked) `fetch('/api/v1/providers')` in jsdom.
jest.mock('@/hooks/use-providers', () => ({
  providers: signal([
    {
      name: 'openai',
      type: 'openai',
      models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
    },
  ]),
  fetchProviders: jest.fn().mockResolvedValue(undefined),
}));

import { CostRatesPanel } from '@/pages/settings/cost-rates-panel';
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
// children, so every row's Edit-mode RateModal — including its own
// read-only `{modelKey}` text — is present in the DOM alongside that row's
// own summary line, which renders the same text. The row's own paragraph
// always comes first in DOM order, so pick that one explicitly rather than
// an unscoped getByText, which throws on the duplicate match.
function firstMatch(text: string): HTMLElement {
  return screen.getAllByText(text)[0]!;
}

describe('CostRatesPanel', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows empty state when costs is {}', async () => {
    mockFetch.mockResolvedValue({ costs: {} });
    render(<CostRatesPanel />);
    await waitFor(() => expect(screen.getByText(/No cost rates configured/)).toBeInTheDocument());
    expect(screen.getByText(/Add a rate/)).toBeInTheDocument();
  });

  it('renders rows with model key and prices when costs are set', async () => {
    mockFetch.mockResolvedValue({
      costs: {
        'gpt-4o': {
          inputPer1kTokens: 0.005,
          inputScale: '1k',
          outputPer1kTokens: 0.015,
          outputScale: '1k',
        },
        'claude-3-opus': {
          inputPer1kTokens: 0.015,
          inputScale: '1k',
          outputPer1kTokens: 0.075,
          outputScale: '1k',
        },
      },
    });

    render(<CostRatesPanel />);
    await waitFor(() => expect(firstMatch('gpt-4o')).toBeInTheDocument());

    expect(firstMatch('claude-3-opus')).toBeInTheDocument();
    expect(screen.getByText(/In: \$0.005\/1k/)).toBeInTheDocument();
    expect(screen.getByText(/In: \$0.015\/1k/)).toBeInTheDocument();
  });

  it('shows a 1M-scale entry converted to its stored unit', async () => {
    mockFetch.mockResolvedValue({
      costs: {
        'glm/glm-5.3': {
          inputPer1kTokens: 0.0014,
          inputScale: '1M',
          outputPer1kTokens: 0.0044,
          outputScale: '1M',
        },
      },
    });

    render(<CostRatesPanel />);
    await waitFor(() => expect(firstMatch('glm/glm-5.3')).toBeInTheDocument());

    expect(screen.getByText(/In: \$1.4\/1M/)).toBeInTheDocument();
    expect(screen.getByText(/Out: \$4.4\/1M/)).toBeInTheDocument();
  });

  it('delete button removes a row', async () => {
    mockFetch.mockResolvedValue({
      costs: {
        'gpt-4o': {
          inputPer1kTokens: 0.005,
          inputScale: '1k',
          outputPer1kTokens: 0.015,
          outputScale: '1k',
        },
      },
    });

    render(<CostRatesPanel />);
    await waitFor(() => expect(firstMatch('gpt-4o')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('gpt-4o')).not.toBeInTheDocument());
    expect(screen.getByText('Save changes')).toBeInTheDocument(); // bar appeared
  });

  it('renders Add rate button', async () => {
    mockFetch.mockResolvedValue({ costs: {} });
    render(<CostRatesPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: 'Add rate' })[0]).toBeInTheDocument();
  });

  it('adds a rate via the provider/model picker and the scaled cost input', async () => {
    mockFetch.mockResolvedValue({ costs: {} });
    const { container } = render(<CostRatesPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    // The mocked Dialog (test/__mocks__/preact-dialog.tsx) always renders
    // both the trigger and the form content, so the Add-rate form is
    // already present — no need to "open" it first.
    firePointerDown(screen.getByText('Select provider/model…'));
    openSubmenu(screen.getByText('openai'));
    fireEvent.click(screen.getByText('gpt-4o-mini'));

    // Two ScaledCostInputs (input/output) each render their own "1M" radio
    // and number field with the same accessible name, so scope both queries
    // to the Input-cost field's own grid container.
    const inputCostField = screen.getByLabelText('Input cost');
    const inputCostContainer = inputCostField.parentElement as HTMLElement;
    fireEvent.click(within(inputCostContainer).getByRole('radio', { name: '1M' }));
    fireEvent.input(inputCostField, { target: { value: '1.4' } });

    const form = container.querySelector('form') as HTMLFormElement;
    fireEvent.click(within(form).getByRole('button', { name: 'Add rate' }));

    await waitFor(() => expect(firstMatch('openai/gpt-4o-mini')).toBeInTheDocument());
    expect(screen.getByText(/In: \$1.4\/1M/)).toBeInTheDocument();
  });
});
