import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

jest.mock('@/services/mcp-servers-api', () => ({
  testNewMcpServer: jest.fn(),
  testExistingMcpServer: jest.fn(),
}));

import { McpServerDrawer } from '@/pages/settings/mcp-server-drawer';
import * as api from '@/services/mcp-servers-api';

const mockTestNew = api.testNewMcpServer as jest.MockedFunction<typeof api.testNewMcpServer>;
const mockTestExisting = api.testExistingMcpServer as jest.MockedFunction<
  typeof api.testExistingMcpServer
>;

// A distinct label from the drawer's own internal submit button ("Add
// server" / "Save") so button queries below aren't ambiguous.
const OPEN_TRIGGER = <button type="button">Open drawer</button>;

const EMPTY_CAPABILITIES = { tools: [], resources: [], resourceTemplates: [] };

describe('McpServerDrawer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defaults to the stdio field set in add mode', () => {
    render(<McpServerDrawer mode="add" onSave={jest.fn()} trigger={OPEN_TRIGGER} />);
    expect(screen.getByLabelText('Command')).toBeInTheDocument();
    expect(screen.queryByLabelText('URL')).not.toBeInTheDocument();
  });

  it('switches to the http/sse field set when transport changes', async () => {
    render(<McpServerDrawer mode="add" onSave={jest.fn()} trigger={OPEN_TRIGGER} />);
    // Radix Select is a listbox, not a native <select> — open it, then pick
    // the option, rather than firing a `change` event on the trigger.
    // getByRole('option', ...) rather than getByText: Radix also renders a
    // visually-hidden native <select> for form integration, whose <option>
    // has the same text but is excluded from the accessibility tree.
    fireEvent.click(screen.getByLabelText('Transport'));
    fireEvent.click(await screen.findByRole('option', { name: 'http' }));
    expect(screen.getByLabelText('URL')).toBeInTheDocument();
    expect(screen.queryByLabelText('Command')).not.toBeInTheDocument();
  });

  it('pre-fills fields from `initial` in edit mode and disables the name field', () => {
    render(
      <McpServerDrawer
        mode="edit"
        initial={{
          name: 'weather',
          config: { command: 'node', args: ['a.js', 'b.js'], enabled: true },
        }}
        onSave={jest.fn()}
        trigger={OPEN_TRIGGER}
      />,
    );
    expect(screen.getByLabelText('Name')).toHaveValue('weather');
    expect(screen.getByLabelText('Name')).toBeDisabled();
    expect(screen.getByLabelText('Command')).toHaveValue('node');
  });

  describe('Capabilities panel', () => {
    it('starts idle with a hint to test the connection', () => {
      render(<McpServerDrawer mode="add" onSave={jest.fn()} trigger={OPEN_TRIGGER} />);
      expect(
        screen.getByText('Click Test connection to see what this server exposes.'),
      ).toBeInTheDocument();
    });

    it('Test connection shows the returned tools and resources', async () => {
      mockTestNew.mockResolvedValue({
        tools: [{ name: 'get_weather', description: 'Fetches the weather' }],
        resources: [{ uri: 'file:///forecast.json', name: 'forecast' }],
        resourceTemplates: [],
      });
      render(<McpServerDrawer mode="add" onSave={jest.fn()} trigger={OPEN_TRIGGER} />);

      fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'node' } });
      fireEvent.click(screen.getByRole('button', { name: /Test connection/ }));

      await waitFor(() => expect(screen.getByText('get_weather')).toBeInTheDocument());
      expect(screen.getByText('Fetches the weather')).toBeInTheDocument();
      expect(screen.getByText('forecast')).toBeInTheDocument();
      expect(screen.getByText('file:///forecast.json')).toBeInTheDocument();
      expect(mockTestNew).toHaveBeenCalled();
    });

    it('shows "No resources exposed." when tools exist but resources do not', async () => {
      mockTestNew.mockResolvedValue({
        tools: [{ name: 'get_weather', description: 'Fetches the weather' }],
        resources: [],
        resourceTemplates: [],
      });
      render(<McpServerDrawer mode="add" onSave={jest.fn()} trigger={OPEN_TRIGGER} />);

      fireEvent.click(screen.getByRole('button', { name: /Test connection/ }));

      await waitFor(() => expect(screen.getByText('No resources exposed.')).toBeInTheDocument());
    });

    it('Test connection shows an inline error on failure', async () => {
      mockTestNew.mockRejectedValue(new Error('spawn ENOENT'));
      render(<McpServerDrawer mode="add" onSave={jest.fn()} trigger={OPEN_TRIGGER} />);

      fireEvent.click(screen.getByRole('button', { name: /Test connection/ }));

      await waitFor(() => expect(screen.getByText('spawn ENOENT')).toBeInTheDocument());
    });

    it('Test connection in edit mode probes the existing server by name', async () => {
      mockTestExisting.mockResolvedValue(EMPTY_CAPABILITIES);
      render(
        <McpServerDrawer
          mode="edit"
          initial={{ name: 'weather', config: { command: 'node', args: [], enabled: true } }}
          onSave={jest.fn()}
          trigger={OPEN_TRIGGER}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /Test connection/ }));

      await waitFor(() =>
        expect(mockTestExisting).toHaveBeenCalledWith('weather', expect.anything()),
      );
      expect(mockTestNew).not.toHaveBeenCalled();
    });
  });

  describe('auto-fetch on open', () => {
    it('automatically probes capabilities when the Edit drawer is opened', async () => {
      mockTestExisting.mockResolvedValue(EMPTY_CAPABILITIES);
      render(
        <McpServerDrawer
          mode="edit"
          initial={{ name: 'weather', config: { command: 'node', args: [], enabled: true } }}
          onSave={jest.fn()}
          trigger={OPEN_TRIGGER}
        />,
      );

      expect(mockTestExisting).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));

      await waitFor(() =>
        expect(mockTestExisting).toHaveBeenCalledWith('weather', expect.anything()),
      );
    });

    it('does not auto-probe in Add mode when the drawer is opened', async () => {
      render(<McpServerDrawer mode="add" onSave={jest.fn()} trigger={OPEN_TRIGGER} />);

      fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));

      expect(mockTestNew).not.toHaveBeenCalled();
      expect(
        screen.getByText('Click Test connection to see what this server exposes.'),
      ).toBeInTheDocument();
    });
  });

  it('Save calls onSave with the built config', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(<McpServerDrawer mode="add" onSave={onSave} trigger={OPEN_TRIGGER} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'weather' } });
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'node' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        'weather',
        expect.objectContaining({ command: 'node', enabled: true }),
      ),
    );
  });

  it('shows an inline error and does not throw when onSave rejects', async () => {
    const onSave = jest.fn().mockRejectedValue(new Error('name already exists'));
    render(<McpServerDrawer mode="add" onSave={onSave} trigger={OPEN_TRIGGER} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'weather' } });
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'node' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));

    await waitFor(() => expect(screen.getByText('name already exists')).toBeInTheDocument());
  });
});
