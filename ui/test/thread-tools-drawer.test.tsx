import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

jest.mock('@/services/tool-settings-api', () => ({
  fetchThreadTools: jest.fn(),
  putThreadTools: jest.fn(),
  resetThreadTools: jest.fn(),
}));
jest.mock('@/lib/toast', () => ({ showToast: jest.fn() }));

import { ThreadToolsDrawer } from '@/components/thread-tools-drawer';
import {
  openThreadToolsDrawer,
  closeThreadToolsDrawer,
  resetThreadToolsState,
} from '@/hooks/use-thread-tools';
import * as api from '@/services/tool-settings-api';
import type { ThreadToolsResponse, ThreadToolItem } from '@/services/tool-settings-api';

const mockFetch = api.fetchThreadTools as jest.MockedFunction<typeof api.fetchThreadTools>;
const mockPut = api.putThreadTools as jest.MockedFunction<typeof api.putThreadTools>;

function tool(overrides: Partial<ThreadToolItem>): ThreadToolItem {
  return {
    toolId: 'web_fetch',
    name: 'Web Fetch',
    description: 'd',
    category: 'built-in',
    alwaysOn: false,
    enabled: true,
    mcpServer: null,
    lastSeenAt: null,
    lastStatus: null,
    defaultInclude: { chat: true, subAgent: false, autonomous: true },
    instructions: '',
    selected: true,
    ...overrides,
  };
}

function buildResponse(): ThreadToolsResponse {
  return {
    customized: false,
    tools: [
      tool({
        toolId: 'wiki_search',
        name: 'Wiki Search',
        category: 'wiki',
        alwaysOn: true,
        selected: true,
      }),
      tool({
        toolId: 'create_workspace',
        name: 'Create Workspace',
        category: 'skill-gated',
        alwaysOn: false,
        selected: false,
      }),
      tool({ toolId: 'web_fetch', name: 'Web Fetch', category: 'built-in', selected: true }),
      tool({ toolId: 'shell_exec', name: 'Shell Exec', category: 'built-in', selected: false }),
      tool({
        toolId: 'shell_exec_off',
        name: 'Disabled Tool',
        category: 'built-in',
        enabled: false,
        selected: false,
      }),
      tool({
        toolId: 'weather:get_forecast',
        name: 'Get Forecast',
        category: 'mcp',
        mcpServer: 'weather',
        selected: false,
      }),
    ],
  };
}

describe('ThreadToolsDrawer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetThreadToolsState();
    mockFetch.mockResolvedValue(buildResponse());
  });

  it('is not visible until openThreadToolsDrawer is called', () => {
    render(<ThreadToolsDrawer />);
    expect(screen.queryByText('Web Fetch')).not.toBeInTheDocument();
  });

  it('renders tools into Built-in / Assigned / Available sections', async () => {
    render(<ThreadToolsDrawer />);
    await openThreadToolsDrawer('t1');
    await waitFor(() => expect(screen.getByText('Web Fetch')).toBeInTheDocument());

    expect(screen.getByText('Always on')).toBeInTheDocument();
    expect(screen.getByText('Gated by skill')).toBeInTheDocument();

    const webFetchRow = screen.getByText('Web Fetch').closest('li')!;
    expect(webFetchRow.querySelector('button')).toHaveTextContent('Remove');

    const shellExecRow = screen.getByText('Shell Exec').closest('li')!;
    expect(shellExecRow.querySelector('button')).toHaveTextContent('+ Add');

    const forecastRow = screen.getByText('Get Forecast').closest('li')!;
    expect(forecastRow.querySelector('button')).toHaveTextContent('+ Add');
  });

  it('a disabled, unselected tool does not appear anywhere', async () => {
    render(<ThreadToolsDrawer />);
    await openThreadToolsDrawer('t1');
    await waitFor(() => expect(screen.getByText('Web Fetch')).toBeInTheDocument());

    expect(screen.queryByText('Disabled Tool')).not.toBeInTheDocument();
  });

  it('renders an MCP row\'s origin badge as "MCP: <server>" and a non-MCP row\'s as "Built-in"', async () => {
    render(<ThreadToolsDrawer />);
    await openThreadToolsDrawer('t1');
    await waitFor(() => expect(screen.getByText('Get Forecast')).toBeInTheDocument());

    const forecastRow = screen.getByText('Get Forecast').closest('li')!;
    expect(forecastRow.querySelector('[data-slot="thread-tool-row-badge"]')).toHaveTextContent(
      'MCP: weather',
    );

    const webFetchRow = screen.getByText('Web Fetch').closest('li')!;
    expect(webFetchRow.querySelector('[data-slot="thread-tool-row-badge"]')).toHaveTextContent(
      'Built-in',
    );
  });

  it('+ Add moves a tool from Available to Assigned locally, with no network call', async () => {
    render(<ThreadToolsDrawer />);
    await openThreadToolsDrawer('t1');
    await waitFor(() => expect(screen.getByText('Shell Exec')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Shell Exec').closest('li')!.querySelector('button')!);

    await waitFor(() =>
      expect(
        screen.getByText('Shell Exec').closest('li')!.querySelector('button'),
      ).toHaveTextContent('Remove'),
    );
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('Remove moves a tool from Assigned back to Available locally, with no network call', async () => {
    render(<ThreadToolsDrawer />);
    await openThreadToolsDrawer('t1');
    await waitFor(() => expect(screen.getByText('Web Fetch')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Web Fetch').closest('li')!.querySelector('button')!);

    await waitFor(() =>
      expect(
        screen.getByText('Web Fetch').closest('li')!.querySelector('button'),
      ).toHaveTextContent('+ Add'),
    );
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('Save sends the full resulting assigned id set', async () => {
    mockPut.mockResolvedValue({ ...buildResponse(), customized: true });
    render(<ThreadToolsDrawer />);
    await openThreadToolsDrawer('t1');
    await waitFor(() => expect(screen.getByText('Web Fetch')).toBeInTheDocument());

    // Add shell_exec, remove web_fetch.
    fireEvent.click(screen.getByText('Shell Exec').closest('li')!.querySelector('button')!);
    fireEvent.click(screen.getByText('Web Fetch').closest('li')!.querySelector('button')!);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    const [threadId, toolIds] = mockPut.mock.calls[0]!;
    expect(threadId).toBe('t1');
    expect(new Set(toolIds)).toEqual(new Set(['shell_exec']));
  });

  it('closing the drawer without Save issues no PUT request', async () => {
    render(<ThreadToolsDrawer />);
    await openThreadToolsDrawer('t1');
    await waitFor(() => expect(screen.getByText('Shell Exec')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Shell Exec').closest('li')!.querySelector('button')!);
    closeThreadToolsDrawer();

    expect(mockPut).not.toHaveBeenCalled();
  });

  it('search filters the Available section only', async () => {
    render(<ThreadToolsDrawer />);
    await openThreadToolsDrawer('t1');
    await waitFor(() => expect(screen.getByText('Shell Exec')).toBeInTheDocument());

    fireEvent.input(screen.getByLabelText('Search available tools'), {
      target: { value: 'shell' },
    });

    expect(screen.getByText('Shell Exec')).toBeInTheDocument();
    expect(screen.queryByText('Get Forecast')).not.toBeInTheDocument();
    // Assigned rows are never filtered by the Available search box.
    expect(screen.getByText('Web Fetch')).toBeInTheDocument();
  });

  it('shows "No tools assigned yet" when Assigned is empty', async () => {
    mockFetch.mockResolvedValue({
      customized: false,
      tools: [tool({ toolId: 'shell_exec', name: 'Shell Exec', selected: false })],
    });
    render(<ThreadToolsDrawer />);
    await openThreadToolsDrawer('t1');

    await waitFor(() => expect(screen.getByText('No tools assigned yet')).toBeInTheDocument());
  });

  it('shows "No matching tools" only when a search query excludes everything, not when Available is simply empty', async () => {
    // First: a query that excludes every Available row (there are some,
    // from buildResponse's defaults) shows the message.
    render(<ThreadToolsDrawer />);
    await openThreadToolsDrawer('t1');
    await waitFor(() => expect(screen.getByText('Shell Exec')).toBeInTheDocument());
    expect(screen.queryByText('No matching tools')).not.toBeInTheDocument();

    fireEvent.input(screen.getByLabelText('Search available tools'), {
      target: { value: 'nonexistent' },
    });
    expect(screen.getByText('No matching tools')).toBeInTheDocument();
  });

  it('does not show "No matching tools" when Available is empty with no search query', async () => {
    mockFetch.mockResolvedValue({
      customized: false,
      tools: [tool({ toolId: 'web_fetch', name: 'Web Fetch', selected: true })],
    });
    render(<ThreadToolsDrawer />);
    await openThreadToolsDrawer('t1');
    await waitFor(() => expect(screen.getByText('Web Fetch')).toBeInTheDocument());

    expect(screen.queryByText('No matching tools')).not.toBeInTheDocument();
  });
});
