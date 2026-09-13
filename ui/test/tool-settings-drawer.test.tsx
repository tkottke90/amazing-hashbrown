import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

jest.mock('@/services/tool-settings-api', () => ({
  patchToolSetting: jest.fn(),
  resetToolSetting: jest.fn(),
}));
jest.mock('@/lib/toast', () => ({ showToast: jest.fn() }));

import { ToolSettingsDrawer } from '@/components/tool-settings-drawer';
import * as api from '@/services/tool-settings-api';
import type { ToolSettingItem } from '@/services/tool-settings-api';

const mockPatch = api.patchToolSetting as jest.MockedFunction<typeof api.patchToolSetting>;
const mockReset = api.resetToolSetting as jest.MockedFunction<typeof api.resetToolSetting>;

// Distinct from the drawer's own internal "Save"/"Reset Defaults" buttons —
// same convention as settings-mcp-server-drawer.test.tsx's OPEN_TRIGGER.
const OPEN_TRIGGER = <button type="button">Open drawer</button>;

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

describe('ToolSettingsDrawer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('pre-fills description/instructions from the tool', () => {
    render(
      <ToolSettingsDrawer
        tool={tool({ instructions: 'be concise' })}
        onSaved={jest.fn()}
        trigger={OPEN_TRIGGER}
      />,
    );
    expect(screen.getByLabelText('Description')).toHaveValue(
      'Fetch and summarize the contents of a URL.',
    );
    expect(screen.getByLabelText('Instructions')).toHaveValue('be concise');
  });

  it('renders web_fetch-specific fields only for that toolId', () => {
    render(
      <ToolSettingsDrawer
        tool={tool({ toolId: 'web_fetch', timeoutMs: 5000 })}
        onSaved={jest.fn()}
        trigger={OPEN_TRIGGER}
      />,
    );
    expect(screen.getByLabelText('Timeout (ms)')).toHaveValue(5000);
    expect(screen.queryByLabelText('Provider')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Allowlist (one glob per line)')).not.toBeInTheDocument();
  });

  it('renders rlm_query-specific fields only for that toolId', () => {
    render(
      <ToolSettingsDrawer
        tool={tool({ toolId: 'rlm_query', provider: 'ollama', maxIterations: 5 })}
        onSaved={jest.fn()}
        trigger={OPEN_TRIGGER}
      />,
    );
    expect(screen.getByLabelText('Provider')).toHaveValue('ollama');
    expect(screen.getByLabelText('Max iterations')).toHaveValue(5);
    expect(screen.queryByLabelText('Timeout (ms)')).not.toBeInTheDocument();
  });

  it('renders shell_exec-specific fields only for that toolId', () => {
    render(
      <ToolSettingsDrawer
        tool={tool({ toolId: 'shell_exec', allowlist: ['**/*.txt'], denylist: [] })}
        onSaved={jest.fn()}
        trigger={OPEN_TRIGGER}
      />,
    );
    expect(screen.getByLabelText('Allowlist (one glob per line)')).toHaveValue('**/*.txt');
    expect(screen.getByLabelText('Denylist (one glob per line)')).toHaveValue('');
  });

  it('locks Enabled/include switches for an alwaysOn tool but keeps description/instructions editable', () => {
    render(
      <ToolSettingsDrawer
        tool={tool({ toolId: 'wiki_search', alwaysOn: true })}
        onSaved={jest.fn()}
        trigger={OPEN_TRIGGER}
      />,
    );
    expect(screen.getByText('Always on')).toBeInTheDocument();
    expect(screen.queryByLabelText('Enable Web Fetch')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Description')).not.toBeDisabled();
  });

  it('renders fully read-only for a skill-gated tool, with no Save/Reset footer', () => {
    render(
      <ToolSettingsDrawer
        tool={tool({ toolId: 'create_workspace', category: 'skill-gated' })}
        onSaved={jest.fn()}
        trigger={OPEN_TRIGGER}
      />,
    );
    expect(screen.getByLabelText('Description')).toBeDisabled();
    expect(screen.getByLabelText('Instructions')).toBeDisabled();
    expect(screen.queryByText('Save')).not.toBeInTheDocument();
    expect(screen.queryByText('Reset Defaults')).not.toBeInTheDocument();
  });

  it('Save sends the generic fields plus the matching tool-specific extra fields', async () => {
    mockPatch.mockResolvedValue(tool({ enabled: false }));
    const onSaved = jest.fn();
    render(
      <ToolSettingsDrawer
        tool={tool({ toolId: 'web_fetch' })}
        onSaved={onSaved}
        trigger={OPEN_TRIGGER}
      />,
    );

    fireEvent.click(screen.getByLabelText('Enable Web Fetch'));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
    expect(mockPatch).toHaveBeenCalledWith(
      'web_fetch',
      expect.objectContaining({
        enabled: false,
        timeoutMs: 10000,
        respectRobotsTxt: true,
      }),
    );
    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ enabled: false })),
    );
  });

  it('Reset Defaults calls the reset endpoint', async () => {
    mockReset.mockResolvedValue(tool());
    const onSaved = jest.fn();
    render(<ToolSettingsDrawer tool={tool()} onSaved={onSaved} trigger={OPEN_TRIGGER} />);

    fireEvent.click(screen.getByText('Reset Defaults'));

    await waitFor(() => expect(mockReset).toHaveBeenCalledWith('web_fetch'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
