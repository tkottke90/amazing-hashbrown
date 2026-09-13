import { render, screen, waitFor, fireEvent } from '@testing-library/preact';

jest.mock('@/lib/toast', () => ({ showToast: jest.fn() }));
jest.mock('@/services/tool-settings-api', () => ({
  fetchToolSettings: jest.fn(),
  patchToolSetting: jest.fn(),
  resetToolSetting: jest.fn(),
  refreshToolSettings: jest.fn(),
}));

import { ToolAccessTable } from '@/pages/settings/tool-access-table';
import * as api from '@/services/tool-settings-api';
import type { ToolSettingItem } from '@/services/tool-settings-api';

const mockFetch = api.fetchToolSettings as jest.MockedFunction<typeof api.fetchToolSettings>;
const mockRefresh = api.refreshToolSettings as jest.MockedFunction<typeof api.refreshToolSettings>;

// This file focuses on behavior settings-tools-panel.test.tsx doesn't already
// cover at the panel level: MCP status-dot rendering, the Source column
// label, a row's own drawer showing that row's own data (not a neighbor's),
// and the Refresh action.
function tool(overrides: Partial<ToolSettingItem> = {}): ToolSettingItem {
  return {
    toolId: 'web_fetch',
    name: 'Web Fetch',
    description: 'Fetch and summarize the contents of a URL.',
    category: 'built-in',
    alwaysOn: false,
    mcpServer: null,
    lastSeenAt: null,
    lastStatus: null,
    enabled: true,
    defaultInclude: { chat: true, subAgent: false, autonomous: true },
    instructions: '',
    ...overrides,
  };
}

describe('ToolAccessTable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('labels built-in/wiki/skill-gated rows "Built-in" and mcp rows "MCP"', async () => {
    mockFetch.mockResolvedValue([
      tool({ toolId: 'web_fetch', name: 'Alpha Built-in', category: 'built-in' }),
      tool({
        toolId: 'weather:get_forecast',
        name: 'Bravo Mcp',
        category: 'mcp',
        mcpServer: 'weather',
      }),
      tool({ toolId: 'wiki_search', name: 'Charlie Wiki', category: 'wiki' }),
    ]);
    render(<ToolAccessTable />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    const sources = document.querySelectorAll('[data-slot="tool-access-row-source"]');
    expect(Array.from(sources).map((s) => s.textContent)).toEqual(['Built-in', 'MCP', 'Built-in']);
  });

  it('renders an MCP status dot colored by lastStatus, and no dot for non-mcp rows', async () => {
    mockFetch.mockResolvedValue([
      tool({
        toolId: 'weather:get_forecast',
        name: 'Connected Tool',
        category: 'mcp',
        mcpServer: 'weather',
        lastStatus: 'connected',
      }),
      tool({
        toolId: 'weather:get_alerts',
        name: 'Unreachable Tool',
        category: 'mcp',
        mcpServer: 'weather',
        lastStatus: 'unreachable',
      }),
      tool({
        toolId: 'weather:get_radar',
        name: 'Unknown Tool',
        category: 'mcp',
        mcpServer: 'weather',
        lastStatus: null,
      }),
      tool({ toolId: 'web_fetch', name: 'Web Fetch', category: 'built-in' }),
    ]);
    render(<ToolAccessTable />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    const connectedRow = screen.getByText('Connected Tool').closest('button');
    const unreachableRow = screen.getByText('Unreachable Tool').closest('button');
    const unknownRow = screen.getByText('Unknown Tool').closest('button');
    const webFetchRow = screen.getByText('Web Fetch').closest('button');

    expect(connectedRow?.querySelector('.bg-green-500')).toBeInTheDocument();
    expect(unreachableRow?.querySelector('.bg-destructive')).toBeInTheDocument();
    expect(unknownRow?.querySelector('.bg-muted-foreground\\/40')).toBeInTheDocument();
    expect(webFetchRow?.querySelector('[class*="rounded-full"]')).not.toBeInTheDocument();
  });

  it("each row's drawer shows that row's own data, not a neighboring row's", async () => {
    mockFetch.mockResolvedValue([
      tool({
        toolId: 'rlm_query',
        name: 'RLM Query',
        category: 'built-in',
        description: 'Runs the retrieval loop model.',
        instructions: 'prefer concise answers',
      }),
      tool({
        toolId: 'web_fetch',
        name: 'Web Fetch',
        category: 'built-in',
        description: 'Fetch and summarize the contents of a URL.',
        instructions: '',
      }),
    ]);
    render(<ToolAccessTable />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    // Each row mounts its own <ToolSettingsDrawer>, and their form fields all
    // share the same id (e.g. "tool-settings-description") — valid per-drawer
    // but duplicated across rows, so getByLabelText's htmlFor->getElementById
    // lookup would collapse them all onto the first row's element. Querying
    // by id selector directly (which, unlike getElementById, doesn't dedupe)
    // is the only way to see each row's own field.
    const descriptions = Array.from(
      document.querySelectorAll<HTMLTextAreaElement>('#tool-settings-description'),
    );
    const instructions = Array.from(
      document.querySelectorAll<HTMLTextAreaElement>('#tool-settings-instructions'),
    );

    expect(descriptions.map((d) => d.value)).toEqual([
      'Runs the retrieval loop model.',
      'Fetch and summarize the contents of a URL.',
    ]);
    expect(instructions.map((i) => i.value)).toEqual(['prefer concise answers', '']);
  });

  it('Refresh re-fetches via refreshToolSettings and re-renders the returned list', async () => {
    mockFetch.mockResolvedValue([tool({ toolId: 'web_fetch', name: 'Web Fetch' })]);
    mockRefresh.mockResolvedValue([
      tool({ toolId: 'web_fetch', name: 'Web Fetch' }),
      tool({ toolId: 'weather:get_forecast', name: 'Get Forecast', category: 'mcp' }),
    ]);
    render(<ToolAccessTable />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));

    await waitFor(() => expect(screen.getByText('Get Forecast')).toBeInTheDocument());
    expect(mockRefresh).toHaveBeenCalled();
  });
});
