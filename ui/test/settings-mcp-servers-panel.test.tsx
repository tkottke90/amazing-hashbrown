import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

jest.mock('@/services/mcp-servers-api', () => ({
  fetchMcpServers: jest.fn(),
  createMcpServer: jest.fn(),
  patchMcpServer: jest.fn(),
  deleteMcpServer: jest.fn(),
  testNewMcpServer: jest.fn(),
  testExistingMcpServer: jest.fn(),
}));
jest.mock('@/lib/toast', () => ({ showToast: jest.fn() }));

import { McpServersPanel } from '@/pages/settings/mcp-servers-panel';
import * as api from '@/services/mcp-servers-api';

const mockFetch = api.fetchMcpServers as jest.MockedFunction<typeof api.fetchMcpServers>;
const mockPatch = api.patchMcpServer as jest.MockedFunction<typeof api.patchMcpServer>;
const mockDelete = api.deleteMcpServer as jest.MockedFunction<typeof api.deleteMcpServer>;
const mockTestExisting = api.testExistingMcpServer as jest.MockedFunction<
  typeof api.testExistingMcpServer
>;

const SERVER = {
  name: 'weather',
  config: { transport: 'stdio' as const, command: 'node', args: ['weather.js'], enabled: true },
};

describe('McpServersPanel', () => {
  const originalConfirm = global.confirm;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue([SERVER]);
    global.confirm = jest.fn(() => true);
  });

  afterEach(() => {
    global.confirm = originalConfirm;
  });

  it('renders a row for each configured server with its transport badge', async () => {
    render(<McpServersPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
    expect(screen.getByText('weather')).toBeInTheDocument();
    expect(screen.getByText('stdio')).toBeInTheDocument();
  });

  it('shows empty state when no servers are configured', async () => {
    mockFetch.mockResolvedValue([]);
    render(<McpServersPanel />);
    await waitFor(() =>
      expect(screen.getByText(/No MCP servers configured/)).toBeInTheDocument(),
    );
  });

  it('starts each row as "Not checked"', async () => {
    render(<McpServersPanel />);
    await waitFor(() => expect(screen.getByText('Not checked')).toBeInTheDocument());
  });

  it('toggling enabled calls patchMcpServer and refreshes', async () => {
    mockPatch.mockResolvedValue({
      ...SERVER,
      config: { ...SERVER.config, enabled: false },
    });
    render(<McpServersPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    const toggle = screen.getByRole('switch', { name: 'Enable weather' });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith('weather', { enabled: false }),
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('Check cycles the status badge through checking to connected', async () => {
    mockTestExisting.mockResolvedValue({ toolCount: 3, toolNames: ['a', 'b', 'c'] });
    render(<McpServersPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Check' }));

    await waitFor(() => expect(screen.getByText('Connected — 3 tools')).toBeInTheDocument());
    expect(mockTestExisting).toHaveBeenCalledWith('weather', SERVER.config);
  });

  it('Check shows an error status when the probe fails', async () => {
    mockTestExisting.mockRejectedValue(new Error('connection refused'));
    render(<McpServersPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Check' }));

    await waitFor(() =>
      expect(screen.getByText(/Error: connection refused/)).toBeInTheDocument(),
    );
  });

  it('Remove asks for confirmation before deleting', async () => {
    mockDelete.mockResolvedValue(undefined);
    render(<McpServersPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(global.confirm).toHaveBeenCalled();
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('weather'));
  });

  it('Remove does not delete when confirmation is declined', async () => {
    global.confirm = jest.fn(() => false);
    render(<McpServersPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(mockDelete).not.toHaveBeenCalled();
  });
});
