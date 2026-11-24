import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

const mockVerifyGithubToken = jest.fn();
const mockVerifyTodoistToken = jest.fn();
jest.mock('@/services/trackers-api', () => ({
  ...jest.requireActual('@/services/trackers-api'),
  verifyGithubToken: (token: string) => mockVerifyGithubToken(token),
  verifyTodoistToken: (token: string) => mockVerifyTodoistToken(token),
}));

import { TrackerConfigModal } from '@/pages/settings/tracker-config-modal';
import type { Tracker } from '@/services/trackers-api';

const GITHUB_TRACKER: Tracker = {
  type: 'github',
  displayName: 'GitHub',
  icon: '<svg></svg>',
  canCreate: true,
  configured: true,
  authSchema: [
    {
      key: 'token',
      label: 'Personal access token',
      type: 'password',
      required: false,
      supportsEnvRef: true,
    },
  ],
};

const GENERIC_TRACKER: Tracker = {
  type: 'todoist',
  displayName: 'Todoist',
  icon: '<svg></svg>',
  canCreate: true,
  configured: true,
  authSchema: [{ key: 'apiKey', label: 'API key', type: 'password', required: false }],
};

describe('TrackerConfigModal', () => {
  it('renders a plain password input for a field without supportsEnvRef [unit]', () => {
    render(
      <TrackerConfigModal
        tracker={GENERIC_TRACKER}
        onSave={jest.fn()}
        trigger={<button>open</button>}
      />,
    );
    fireEvent.click(screen.getByText('open'));
    expect(screen.getByLabelText('API key')).toHaveAttribute('type', 'password');
    // No env-var toggle for this field.
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('renders the CredentialValueField toggle for the token field when supportsEnvRef [unit]', () => {
    render(
      <TrackerConfigModal
        tracker={GITHUB_TRACKER}
        onSave={jest.fn()}
        trigger={<button>open</button>}
      />,
    );
    fireEvent.click(screen.getByText('open'));
    expect(
      screen.getByRole('switch', {
        name: 'Source Personal access token from an environment variable',
      }),
    ).toBeInTheDocument();
  });

  it('submits ${NAME} in the outgoing payload when env mode is used [unit]', () => {
    const onSave = jest.fn();
    render(
      <TrackerConfigModal
        tracker={GITHUB_TRACKER}
        onSave={onSave}
        trigger={<button>open</button>}
      />,
    );
    fireEvent.click(screen.getByText('open'));

    fireEvent.click(
      screen.getByRole('switch', {
        name: 'Source Personal access token from an environment variable',
      }),
    );
    fireEvent.input(screen.getByPlaceholderText('GH_TOKEN'), { target: { value: 'MY_PAT' } });
    fireEvent.click(screen.getByText('Save'));

    expect(onSave).toHaveBeenCalledWith({ token: '${MY_PAT}' });
  });

  it('passes an unchanged literal secret through as the MASK sentinel [unit]', () => {
    const onSave = jest.fn();
    render(
      <TrackerConfigModal
        tracker={GITHUB_TRACKER}
        initial={{ token: '****' }}
        onSave={onSave}
        trigger={<button>open</button>}
      />,
    );
    fireEvent.click(screen.getByText('open'));
    fireEvent.click(screen.getByText('Save'));
    expect(onSave).toHaveBeenCalledWith({ token: '****' });
  });

  it('Remove still forces an empty string regardless of the field mode [unit]', () => {
    const onSave = jest.fn();
    render(
      <TrackerConfigModal
        tracker={GITHUB_TRACKER}
        initial={{ token: '****' }}
        onSave={onSave}
        trigger={<button>open</button>}
      />,
    );
    fireEvent.click(screen.getByText('open'));
    fireEvent.click(screen.getByText('Remove'));
    fireEvent.click(screen.getByText('Save'));
    expect(onSave).toHaveBeenCalledWith({ token: '' });
  });

  it('shows an existing ${VAR} reference pre-filled in env mode [unit]', () => {
    render(
      <TrackerConfigModal
        tracker={GITHUB_TRACKER}
        initial={{ token: '${GH_TOKEN}' }}
        onSave={jest.fn()}
        trigger={<button>open</button>}
      />,
    );
    fireEvent.click(screen.getByText('open'));
    expect(
      screen.getByRole('switch', {
        name: 'Source Personal access token from an environment variable',
      }),
    ).toBeChecked();
    expect(screen.getByDisplayValue('GH_TOKEN')).toBeInTheDocument();
  });

  describe('Verify (per-tracker)', () => {
    const TODOIST_TRACKER: Tracker = {
      type: 'todoist',
      displayName: 'Todoist',
      icon: '<svg></svg>',
      canCreate: false,
      configured: false,
      authSchema: [
        {
          key: 'token',
          label: 'API token',
          type: 'password',
          required: true,
          supportsEnvRef: true,
        },
      ],
    };

    afterEach(() => jest.clearAllMocks());

    function openWith(tracker: Tracker) {
      render(
        <TrackerConfigModal tracker={tracker} onSave={jest.fn()} trigger={<button>open</button>} />,
      );
      fireEvent.click(screen.getByText('open'));
    }

    it("verifies a Todoist token with Todoist's own check and reports Connected [unit]", async () => {
      mockVerifyTodoistToken.mockResolvedValueOnce({ valid: true });
      openWith(TODOIST_TRACKER);
      fireEvent.input(screen.getByLabelText('API token'), { target: { value: 'todoist_tok' } });
      fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
      expect(await screen.findByText('Connected')).toBeInTheDocument();
      expect(mockVerifyTodoistToken).toHaveBeenCalledWith('todoist_tok');
      expect(mockVerifyGithubToken).not.toHaveBeenCalled();
    });

    it("shows Todoist's error when the token is rejected [unit]", async () => {
      mockVerifyTodoistToken.mockResolvedValueOnce({
        valid: false,
        error: 'Todoist API error 401',
      });
      openWith(TODOIST_TRACKER);
      fireEvent.input(screen.getByLabelText('API token'), { target: { value: 'bad' } });
      fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
      expect(await screen.findByText('Todoist API error 401')).toBeInTheDocument();
    });

    it('keeps the GitHub read-only warning for a classic token without repo scope [unit]', async () => {
      mockVerifyGithubToken.mockResolvedValueOnce({
        valid: true,
        scopes: ['read:user'],
        canCreate: false,
        tokenType: 'classic',
      });
      openWith(GITHUB_TRACKER);
      fireEvent.input(screen.getByLabelText('Personal access token'), {
        target: { value: 'ghp_x' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
      expect(await screen.findByText(/Connected — read-only/)).toBeInTheDocument();
      expect(mockVerifyTodoistToken).not.toHaveBeenCalled();
    });

    it('suggests the tracker-specific env var name when switching to an env reference [unit]', () => {
      openWith(TODOIST_TRACKER);
      fireEvent.click(
        screen.getByRole('switch', { name: 'Source API token from an environment variable' }),
      );
      expect(screen.getByDisplayValue('TODOIST_TOKEN')).toBeInTheDocument();
    });

    it('offers no Verify button for a tracker with no verify check (e.g. a plugin) [unit]', async () => {
      openWith({ ...TODOIST_TRACKER, type: 'some-plugin' });
      await waitFor(() => expect(screen.getByLabelText('API token')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
    });
  });
});
