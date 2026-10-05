import { fireEvent, render, screen } from '@testing-library/preact';
import { TrackerConfigModal } from '@/pages/settings/tracker-config-modal';
import type { Tracker } from '@/services/trackers-api';

const GITHUB_TRACKER: Tracker = {
  type: 'github',
  displayName: 'GitHub',
  icon: '<svg></svg>',
  canCreate: true,
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
});
