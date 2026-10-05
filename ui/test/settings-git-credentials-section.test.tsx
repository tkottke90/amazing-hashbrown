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

import { GitCredentialsSection } from '@/pages/settings/git-credentials-section';
import * as api from '@/services/settings-api';

const mockFetch = api.fetchSettingsSection as jest.MockedFunction<typeof api.fetchSettingsSection>;
const mockPatch = api.patchSettingsSection as jest.MockedFunction<typeof api.patchSettingsSection>;

describe('GitCredentialsSection', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows the stored literal token masked [unit]', async () => {
    mockFetch.mockResolvedValue({ github: { token: '****' } });
    render(<GitCredentialsSection />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    expect(screen.getByLabelText('Personal access token')).toHaveAttribute('type', 'password');
  });

  it('shows a stored ${VAR} reference in env mode [unit]', async () => {
    mockFetch.mockResolvedValue({ github: { token: '${GH_TOKEN}' } });
    render(<GitCredentialsSection />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    expect(
      screen.getByRole('switch', {
        name: 'Source Personal access token from an environment variable',
      }),
    ).toBeChecked();
    expect(screen.getByDisplayValue('GH_TOKEN')).toBeInTheDocument();
  });

  it('saves a literal token typed by the user [unit]', async () => {
    mockFetch.mockResolvedValue({ github: {} });
    mockPatch.mockResolvedValue({ github: { token: '****' } });
    render(<GitCredentialsSection />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    fireEvent.input(screen.getByLabelText('Personal access token'), {
      target: { value: 'ghp_new_token' },
    });
    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith('git-credentials', {
        github: { token: 'ghp_new_token' },
      }),
    );
  });

  it('renders a field error from a validation failure [unit]', async () => {
    mockFetch.mockResolvedValue({ github: {} });
    mockPatch.mockRejectedValue(
      new (jest.requireMock('@/services/settings-api').SettingsValidationError)({
        'github.token': ["references ${BAD_VAR}, which isn't set in the API's environment."],
      }),
    );
    render(<GitCredentialsSection />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    fireEvent.click(
      screen.getByRole('switch', {
        name: 'Source Personal access token from an environment variable',
      }),
    );
    fireEvent.input(screen.getByPlaceholderText('GH_TOKEN'), { target: { value: 'BAD_VAR' } });
    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() =>
      expect(screen.getByText(/isn't set in the API's environment/)).toBeInTheDocument(),
    );
  });
});
