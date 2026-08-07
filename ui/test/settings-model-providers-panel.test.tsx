import { render, screen, waitFor } from '@testing-library/preact';

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

import { ModelProvidersPanel } from '@/components/settings/model-providers-panel';
import * as api from '@/services/settings-api';

const mockFetch = api.fetchSettingsSection as jest.MockedFunction<typeof api.fetchSettingsSection>;

const DEFAULT_DATA = {
  providers: [
    { name: 'ollama', type: 'ollama' as const, defaultModel: 'llama3' },
    { name: 'openai', type: 'openai' as const, apiKey: '****' },
  ],
  defaultProvider: 'ollama',
};

describe('ModelProvidersPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue(DEFAULT_DATA);
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
});
