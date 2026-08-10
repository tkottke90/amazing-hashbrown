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

import { EmbeddingsPanel } from '@/pages/settings/embeddings-panel';
import * as api from '@/services/settings-api';

const mockFetch = api.fetchSettingsSection as jest.MockedFunction<typeof api.fetchSettingsSection>;

describe('EmbeddingsPanel', () => {
  beforeEach(() => jest.clearAllMocks());

  it('hides conditional fields when enabled=false', async () => {
    mockFetch.mockResolvedValue({
      enabled: false,
      type: 'ollama',
      model: 'nomic-embed-text',
      baseUrl: 'http://localhost:11434/v1',
    });

    render(<EmbeddingsPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    expect(screen.queryByLabelText('Type')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Base URL')).not.toBeInTheDocument();
  });

  it('shows conditional fields when enabled=true', async () => {
    mockFetch.mockResolvedValue({
      enabled: true,
      type: 'ollama',
      model: 'nomic-embed-text',
      baseUrl: 'http://localhost:11434/v1',
    });

    render(<EmbeddingsPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    expect(screen.getByLabelText('Model')).toBeInTheDocument();
    expect(screen.getByLabelText('Base URL')).toBeInTheDocument();
  });

  it('toggling enabled off hides conditional fields', async () => {
    mockFetch.mockResolvedValue({
      enabled: true,
      type: 'ollama',
      model: 'nomic-embed-text',
      baseUrl: 'http://localhost:11434/v1',
    });

    render(<EmbeddingsPanel />);
    await waitFor(() => expect(screen.getByLabelText('Model')).toBeInTheDocument());

    // Find the Enable embeddings switch by its id and click its container
    const toggle = screen.getByRole('switch', { name: 'Enable embeddings' });
    fireEvent.click(toggle);

    await waitFor(() => expect(screen.queryByLabelText('Model')).not.toBeInTheDocument());
  });
});
