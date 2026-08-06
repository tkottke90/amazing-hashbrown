import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

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

import { CostRatesPanel } from '@/components/settings/cost-rates-panel';
import * as api from '@/services/settings-api';

const mockFetch = api.fetchSettingsSection as jest.MockedFunction<typeof api.fetchSettingsSection>;

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
        'gpt-4o': { inputPer1kTokens: 0.005, outputPer1kTokens: 0.015 },
        'claude-3-opus': { inputPer1kTokens: 0.015, outputPer1kTokens: 0.075 },
      },
    });

    render(<CostRatesPanel />);
    await waitFor(() => expect(screen.getByText('gpt-4o')).toBeInTheDocument());

    expect(screen.getByText('claude-3-opus')).toBeInTheDocument();
    expect(screen.getByText(/In: \$0.005\/1k/)).toBeInTheDocument();
    expect(screen.getByText(/In: \$0.015\/1k/)).toBeInTheDocument();
  });

  it('delete button removes a row', async () => {
    mockFetch.mockResolvedValue({
      costs: {
        'gpt-4o': { inputPer1kTokens: 0.005, outputPer1kTokens: 0.015 },
      },
    });

    render(<CostRatesPanel />);
    await waitFor(() => expect(screen.getByText('gpt-4o')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('gpt-4o')).not.toBeInTheDocument());
    expect(screen.getByText('Save changes')).toBeInTheDocument(); // bar appeared
  });

  it('renders Add rate button', async () => {
    mockFetch.mockResolvedValue({ costs: {} });
    render(<CostRatesPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Add rate' })).toBeInTheDocument();
  });
});
