import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

jest.mock('@/hooks/use-providers', () => ({
  providers: { value: [] },
  fetchProviders: jest.fn(),
}));

import { RoleDrawer } from '@/pages/settings/role-drawer';

// A distinct label from the drawer's own internal submit button ("Add
// role" / "Save") so button queries below aren't ambiguous — same
// rationale as McpServerDrawer's own test file.
const OPEN_TRIGGER = <button type="button">Open drawer</button>;

describe('RoleDrawer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('starts with an empty name and "System default" provider/model in add mode', () => {
    render(<RoleDrawer mode="add" onSave={jest.fn()} trigger={OPEN_TRIGGER} />);
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.getByText('System default')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });

  it('pre-fills fields from `initial` in edit mode, with the Name field still editable', () => {
    render(
      <RoleDrawer
        mode="edit"
        initial={{ name: 'researcher', provider: 'ollama', model: 'llama3' }}
        onSave={jest.fn()}
        trigger={OPEN_TRIGGER}
      />,
    );
    expect(screen.getByLabelText('Name')).toHaveValue('researcher');
    expect(screen.getByLabelText('Name')).not.toBeDisabled();
    expect(screen.getByText('ollama / llama3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
  });

  it('"Clear" resets provider/model back to "System default"', () => {
    render(
      <RoleDrawer
        mode="edit"
        initial={{ name: 'researcher', provider: 'ollama', model: 'llama3' }}
        onSave={jest.fn()}
        trigger={OPEN_TRIGGER}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText('System default')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });

  it('submits with provider/model/systemPrompt as null when left at "System default" / blank', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(<RoleDrawer mode="add" onSave={onSave} trigger={OPEN_TRIGGER} />);

    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'writer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add role' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        name: 'writer',
        provider: null,
        model: null,
        systemPrompt: null,
      }),
    );
  });

  it('submits the trimmed system prompt when one is entered', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(<RoleDrawer mode="add" onSave={onSave} trigger={OPEN_TRIGGER} />);

    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'writer' } });
    fireEvent.input(screen.getByLabelText('System prompt'), {
      target: { value: '  Be concise.  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add role' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'writer', systemPrompt: 'Be concise.' }),
      ),
    );
  });

  it('shows the save error inline when onSave rejects, without closing', async () => {
    const onSave = jest.fn().mockRejectedValue(new Error('name already exists'));
    render(<RoleDrawer mode="add" onSave={onSave} trigger={OPEN_TRIGGER} />);

    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'writer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add role' }));

    await waitFor(() => expect(screen.getByText('name already exists')).toBeInTheDocument());
  });
});
