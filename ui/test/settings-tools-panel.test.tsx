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

import { ToolsPanel } from '@/components/settings/tools-panel';
import * as api from '@/services/settings-api';

const mockFetch = api.fetchSettingsSection as jest.MockedFunction<typeof api.fetchSettingsSection>;

const PROVIDERS_DATA = { providers: [{ name: 'ollama' }, { name: 'openai' }] };

const DEFAULT_TOOLS = {
  webFetch: { timeoutMs: 10000, respectRobotsTxt: true },
  rlm: { maxIterations: 10, truncateThreshold: 6000 },
  tools: { shell: { allowlist: ['**/*.txt', '**/*.md'], denylist: [] } },
};

describe('ToolsPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // fetchSettingsSection is called twice: once for tools, once for model-providers
    mockFetch.mockImplementation((slug: string) => {
      if (slug === 'model-providers') return Promise.resolve(PROVIDERS_DATA);
      return Promise.resolve(DEFAULT_TOOLS);
    });
  });

  it('renders 3 card headings', async () => {
    render(<ToolsPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    expect(screen.getByText('Web fetch')).toBeInTheDocument();
    expect(screen.getByText('Retrieval loop model')).toBeInTheDocument();
    expect(screen.getByText('Shell execution')).toBeInTheDocument();
  });

  it('renders allowlist textarea with joined string[] content', async () => {
    render(<ToolsPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    const allowlist = screen.getByLabelText('Allowlist (one glob per line)') as HTMLTextAreaElement;
    expect(allowlist.value).toBe('**/*.txt\n**/*.md');
  });

  it('renders empty denylist textarea', async () => {
    render(<ToolsPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    const denylist = screen.getByLabelText('Denylist (one glob per line)') as HTMLTextAreaElement;
    expect(denylist.value).toBe('');
  });
});
