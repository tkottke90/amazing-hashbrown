import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

jest.mock('@/services/tool-settings-api', () => ({
  fetchToolSettings: jest.fn(),
  patchToolSetting: jest.fn(),
  refreshToolSettings: jest.fn(),
}));
jest.mock('@/services/skills-manage-api', () => ({
  fetchAllSkills: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/toast', () => ({ showToast: jest.fn() }));

import { ToolAccessSection } from '@/pages/settings/tool-access-section';
import * as api from '@/services/tool-settings-api';
import type { ToolSettingItem } from '@/services/tool-settings-api';

const mockFetch = api.fetchToolSettings as jest.MockedFunction<typeof api.fetchToolSettings>;
const mockPatch = api.patchToolSetting as jest.MockedFunction<typeof api.patchToolSetting>;
const mockRefresh = api.refreshToolSettings as jest.MockedFunction<typeof api.refreshToolSettings>;

const BASE: ToolSettingItem = {
  toolId: 'web_fetch',
  name: 'Web Fetch',
  description: 'Fetch and summarize a URL.',
  category: 'built-in',
  enabled: true,
  defaultInclude: true,
  mcpServer: null,
  lastSeenAt: null,
  lastStatus: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const WIKI: ToolSettingItem = {
  ...BASE,
  toolId: 'wiki_search',
  name: 'Wiki Search',
  category: 'wiki',
};

const SKILL_GATED: ToolSettingItem = {
  ...BASE,
  toolId: 'create_workspace',
  name: 'Create Workspace',
  category: 'skill-gated',
};

const MCP: ToolSettingItem = {
  ...BASE,
  toolId: 'mcp:pushover:pushover_send',
  name: 'pushover_send',
  category: 'mcp',
  mcpServer: 'pushover',
  lastStatus: 'connected',
  lastSeenAt: '2026-01-01T00:00:00.000Z',
};

describe('ToolAccessSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue([BASE, WIKI, SKILL_GATED, MCP]);
  });

  it('renders every category grouping', async () => {
    render(<ToolAccessSection />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    expect(screen.getByText('Web Fetch')).toBeInTheDocument();
    expect(screen.getByText('Wiki Search')).toBeInTheDocument();
    expect(screen.getByText('Create Workspace')).toBeInTheDocument();
    expect(screen.getByText('pushover_send')).toBeInTheDocument();
    expect(screen.getByText('pushover')).toBeInTheDocument();
  });

  it('wiki rows show "Always on" with no enable switch', async () => {
    render(<ToolAccessSection />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    expect(screen.getByText('Always on')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Enable Wiki Search' })).not.toBeInTheDocument();
  });

  it('skill-gated rows are read-only with no enable switch', async () => {
    render(<ToolAccessSection />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    expect(
      screen.queryByRole('switch', { name: 'Enable Create Workspace' }),
    ).not.toBeInTheDocument();
  });

  it('toggling a built-in tool calls patchToolSetting and refreshes', async () => {
    mockPatch.mockResolvedValue({ ...BASE, enabled: false });
    render(<ToolAccessSection />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('switch', { name: 'Enable Web Fetch' }));

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith('web_fetch', { enabled: false }),
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('the Refresh button calls refreshToolSettings', async () => {
    mockRefresh.mockResolvedValue([BASE, WIKI, SKILL_GATED, MCP]);
    render(<ToolAccessSection />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));

    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
  });

  it('shows the MCP status dot label for a connected tool', async () => {
    render(<ToolAccessSection />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    expect(screen.getByText('Connected')).toBeInTheDocument();
  });
});
