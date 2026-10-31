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
// The Sub-Agents card (rendered inside this page) fetches its own Roles
// list on mount, independent of the batched settings-section fetch above —
// mocked here purely so it doesn't make a real, unmocked network call.
jest.mock('@/services/roles-api', () => ({
  fetchRoles: jest.fn().mockResolvedValue({ roles: [{ name: 'default' }], defaultRole: 'default' }),
  createRole: jest.fn(),
  patchRole: jest.fn(),
  deleteRole: jest.fn(),
  setDefaultRole: jest.fn(),
}));
jest.mock('@/hooks/use-providers', () => ({
  providers: { value: [] },
  fetchProviders: jest.fn(),
}));

import { AgentBehaviorPanel } from '@/pages/settings/agent-behavior-panel';
import * as api from '@/services/settings-api';

const mockFetch = api.fetchSettingsSection as jest.MockedFunction<typeof api.fetchSettingsSection>;

const DEFAULT_DATA = {
  afterAgent: { enabled: true },
  chat: { showErrorMessages: false, codeBlockWrap: false, sidebarRetentionDays: 7 },
  observability: { enabled: true, spanOutputPreviewChars: 500 },
};

describe('AgentBehaviorPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue(DEFAULT_DATA);
  });

  it('renders 4 card headings', async () => {
    render(<AgentBehaviorPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    expect(screen.getByText('Background processing')).toBeInTheDocument();
    expect(screen.getByText('Conversation history')).toBeInTheDocument();
    expect(screen.getByText('Observability')).toBeInTheDocument();
    expect(screen.getByText('Sub-Agents')).toBeInTheDocument();
  });

  it('hides spanOutputPreviewChars when observability.enabled is false', async () => {
    mockFetch.mockResolvedValue({
      ...DEFAULT_DATA,
      observability: { enabled: false, spanOutputPreviewChars: 500 },
    });

    render(<AgentBehaviorPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    expect(screen.queryByLabelText('Span output preview characters')).not.toBeInTheDocument();
  });

  it('shows spanOutputPreviewChars when observability.enabled is true', async () => {
    render(<AgentBehaviorPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Span output preview characters')).toBeInTheDocument();
  });

  it('toggling observability off hides span preview field', async () => {
    render(<AgentBehaviorPanel />);
    await waitFor(() =>
      expect(screen.getByLabelText('Span output preview characters')).toBeInTheDocument(),
    );

    const toggle = screen.getByRole('switch', { name: 'Enable tracing' });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(screen.queryByLabelText('Span output preview characters')).not.toBeInTheDocument(),
    );
  });

  it('reflects chat.codeBlockWrap in the wrap-long-lines switch', async () => {
    mockFetch.mockResolvedValue({
      ...DEFAULT_DATA,
      chat: { showErrorMessages: false, codeBlockWrap: true },
    });

    render(<AgentBehaviorPanel />);

    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Wrap long lines in code blocks' })).toBeChecked(),
    );
  });

  it('toggling wrap long lines flips the switch', async () => {
    render(<AgentBehaviorPanel />);

    const toggle = await waitFor(() =>
      screen.getByRole('switch', { name: 'Wrap long lines in code blocks' }),
    );
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() => expect(toggle).toBeChecked());
  });

  it('renders the sidebar retention field with the fetched value', async () => {
    mockFetch.mockResolvedValue({
      ...DEFAULT_DATA,
      chat: { showErrorMessages: false, codeBlockWrap: false, sidebarRetentionDays: 14 },
    });

    render(<AgentBehaviorPanel />);

    await waitFor(() =>
      expect(screen.getByLabelText('Hide inactive threads from sidebar after (days)')).toHaveValue(
        14,
      ),
    );
  });

  it('editing the sidebar retention field updates the form value', async () => {
    render(<AgentBehaviorPanel />);

    const input = await waitFor(() =>
      screen.getByLabelText('Hide inactive threads from sidebar after (days)'),
    );
    fireEvent.input(input, { target: { value: '30' } });

    await waitFor(() => expect(input).toHaveValue(30));
  });

  it('saving includes sidebarRetentionDays in the PATCH payload', async () => {
    const mockPatch = api.patchSettingsSection as jest.MockedFunction<
      typeof api.patchSettingsSection
    >;
    mockPatch.mockResolvedValue(DEFAULT_DATA);
    render(<AgentBehaviorPanel />);

    const input = await waitFor(() =>
      screen.getByLabelText('Hide inactive threads from sidebar after (days)'),
    );
    fireEvent.input(input, { target: { value: '30' } });
    fireEvent.click(await screen.findByText('Save changes'));

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith(
        'agent-behavior',
        expect.objectContaining({
          chat: expect.objectContaining({ sidebarRetentionDays: 30 }),
        }),
      ),
    );
  });
});
