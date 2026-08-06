import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

jest.mock('@/services/settings-api', () => {
  class SettingsValidationError extends Error {
    fieldErrors: Record<string, string[]> | string;
    constructor(fe: Record<string, string[]> | string) { super('Validation failed'); this.name = 'SettingsValidationError'; this.fieldErrors = fe; }
  }
  return { SettingsValidationError, fetchSettingsSection: jest.fn(), patchSettingsSection: jest.fn() };
});
jest.mock('@/lib/toast', () => ({ showToast: jest.fn() }));

import { AgentBehaviorPanel } from '@/components/settings/agent-behavior-panel';
import * as api from '@/services/settings-api';

const mockFetch = api.fetchSettingsSection as jest.MockedFunction<typeof api.fetchSettingsSection>;

const DEFAULT_DATA = {
  afterAgent: { enabled: true },
  chat: { showErrorMessages: false },
  observability: { enabled: true, spanOutputPreviewChars: 500 },
};

describe('AgentBehaviorPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue(DEFAULT_DATA);
  });

  it('renders 3 card headings', async () => {
    render(<AgentBehaviorPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    expect(screen.getByText('Background processing')).toBeInTheDocument();
    expect(screen.getByText('Conversation history')).toBeInTheDocument();
    expect(screen.getByText('Observability')).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByLabelText('Span output preview characters')).toBeInTheDocument());

    const toggle = screen.getByRole('switch', { name: 'Enable tracing' });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(screen.queryByLabelText('Span output preview characters')).not.toBeInTheDocument(),
    );
  });
});
