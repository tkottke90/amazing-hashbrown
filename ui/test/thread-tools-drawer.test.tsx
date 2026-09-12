import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

jest.mock('@/services/tool-settings-api', () => ({
  fetchThreadTools: jest.fn(),
  putThreadTools: jest.fn(),
  resetThreadTools: jest.fn(),
}));
jest.mock('@/lib/toast', () => ({ showToast: jest.fn() }));

import { ThreadToolsDrawer } from '@/components/thread-tools-drawer';
import { openThreadToolsDrawer, resetThreadToolsState } from '@/hooks/use-thread-tools';
import * as api from '@/services/tool-settings-api';
import type { ThreadToolsResponse, ThreadToolItem } from '@/services/tool-settings-api';

const mockFetch = api.fetchThreadTools as jest.MockedFunction<typeof api.fetchThreadTools>;
const mockPut = api.putThreadTools as jest.MockedFunction<typeof api.putThreadTools>;
const mockReset = api.resetThreadTools as jest.MockedFunction<typeof api.resetThreadTools>;

function tool(overrides: Partial<ThreadToolItem>): ThreadToolItem {
  return {
    toolId: 'web_fetch',
    name: 'Web Fetch',
    description: 'd',
    category: 'built-in',
    enabled: true,
    defaultInclude: true,
    mcpServer: null,
    lastSeenAt: null,
    lastStatus: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    selected: true,
    ...overrides,
  };
}

const RESPONSE: ThreadToolsResponse = {
  customized: false,
  tools: [
    tool({ toolId: 'web_fetch', name: 'Web Fetch', selected: true }),
    tool({ toolId: 'shell_exec', name: 'Shell Exec', selected: false }),
    tool({ toolId: 'shell_exec_off', name: 'Disabled Tool', enabled: false, selected: false }),
    tool({ toolId: 'wiki_search', name: 'Wiki Search', category: 'wiki', selected: true }),
    tool({
      toolId: 'create_workspace',
      name: 'Create Workspace',
      category: 'skill-gated',
      selected: false,
    }),
  ],
};

describe('ThreadToolsDrawer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetThreadToolsState();
    mockFetch.mockResolvedValue(RESPONSE);
  });

  it('is not visible until openThreadToolsDrawer is called', () => {
    render(<ThreadToolsDrawer />);
    expect(screen.queryByText('Web Fetch')).not.toBeInTheDocument();
  });

  it('loads and renders tools grouped by category once opened', async () => {
    render(<ThreadToolsDrawer />);
    await openThreadToolsDrawer('t1');
    await waitFor(() => expect(screen.getByText('Web Fetch')).toBeInTheDocument());

    expect(screen.getByText('Shell Exec')).toBeInTheDocument();
    expect(screen.getByText('Wiki Search')).toBeInTheDocument();
    expect(screen.getByText('Create Workspace')).toBeInTheDocument();
    expect(screen.getByText('Always on')).toBeInTheDocument();
    expect(screen.getByText('Gated by skill')).toBeInTheDocument();
  });

  it('shows a globally-disabled tool greyed out with no way to check it', async () => {
    render(<ThreadToolsDrawer />);
    await openThreadToolsDrawer('t1');
    await waitFor(() => expect(screen.getByText('Disabled Tool')).toBeInTheDocument());

    const checkbox = screen.getByLabelText('Include Disabled Tool') as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(false);
  });

  it('Save sends the exact checked set', async () => {
    mockPut.mockResolvedValue({ ...RESPONSE, customized: true });
    render(<ThreadToolsDrawer />);
    await openThreadToolsDrawer('t1');
    await waitFor(() => expect(screen.getByText('Web Fetch')).toBeInTheDocument());

    // web_fetch starts checked (selected: true); check shell_exec too.
    fireEvent.click(screen.getByLabelText('Include Shell Exec'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    const [threadId, toolIds] = mockPut.mock.calls[0]!;
    expect(threadId).toBe('t1');
    expect(new Set(toolIds)).toEqual(new Set(['web_fetch', 'shell_exec']));
  });

  it('Reset to defaults calls resetThreadTools', async () => {
    mockReset.mockResolvedValue({ ...RESPONSE, customized: false });
    render(<ThreadToolsDrawer />);
    await openThreadToolsDrawer('t1');
    await waitFor(() => expect(screen.getByText('Web Fetch')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));

    await waitFor(() => expect(mockReset).toHaveBeenCalledWith('t1'));
  });
});
