import { render, screen, waitFor, fireEvent } from '@testing-library/preact';

jest.mock('@/lib/toast', () => ({ showToast: jest.fn() }));
jest.mock('@/services/tool-settings-api', () => ({
  fetchToolSettings: jest.fn(),
  patchToolSetting: jest.fn(),
  resetToolSetting: jest.fn(),
  refreshToolSettings: jest.fn(),
}));

import { ToolsPanel } from '@/pages/settings/tools-panel';
import * as api from '@/services/tool-settings-api';
import type { ToolSettingItem } from '@/services/tool-settings-api';

const mockFetch = api.fetchToolSettings as jest.MockedFunction<typeof api.fetchToolSettings>;

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

describe('ToolsPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders every tool row, sorted alphabetically', async () => {
    mockFetch.mockResolvedValue([
      tool({ toolId: 'wiki_search', name: 'Wiki Search' }),
      tool({ toolId: 'ask_user', name: 'Ask User' }),
      tool({ toolId: 'web_fetch', name: 'Web Fetch' }),
    ]);
    render(<ToolsPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    const rows = document.querySelectorAll('[data-slot="tool-access-row-name"]');
    expect(Array.from(rows).map((r) => r.textContent)).toEqual([
      'Ask User',
      'Web Fetch',
      'Wiki Search',
    ]);
  });

  it('filters rows by the search input', async () => {
    mockFetch.mockResolvedValue([
      tool({ toolId: 'wiki_search', name: 'Wiki Search' }),
      tool({ toolId: 'web_fetch', name: 'Web Fetch' }),
    ]);
    render(<ToolsPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    fireEvent.input(screen.getByLabelText('Search tools'), { target: { value: 'wiki' } });

    expect(screen.getByText('Wiki Search')).toBeInTheDocument();
    expect(screen.queryByText('Web Fetch')).not.toBeInTheDocument();
  });

  it('shows a disabled indicator for a globally-disabled tool', async () => {
    mockFetch.mockResolvedValue([tool({ enabled: false })]);
    render(<ToolsPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    expect(screen.getByText('(disabled)')).toBeInTheDocument();
  });
});
