import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

jest.mock('@/services/tool-settings-api', () => ({
  patchToolSetting: jest.fn(),
  resetToolSetting: jest.fn(),
  fetchShellEnvVarNames: jest.fn(),
}));
jest.mock('@/lib/toast', () => ({ showToast: jest.fn() }));

import { ToolSettingsDrawer } from '@/components/tool-settings-drawer';
import * as api from '@/services/tool-settings-api';
import type { ToolSettingItem } from '@/services/tool-settings-api';
import { RequestError } from '@/utils/fetch.utils';

const mockPatch = api.patchToolSetting as jest.MockedFunction<typeof api.patchToolSetting>;
const mockReset = api.resetToolSetting as jest.MockedFunction<typeof api.resetToolSetting>;
const mockEnvNames = api.fetchShellEnvVarNames as jest.MockedFunction<
  typeof api.fetchShellEnvVarNames
>;

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
    mockEnvNames.mockResolvedValue(['GH_TOKEN', 'GITHUB_TOKEN']);
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

  describe('shell_exec environment variables', () => {
    function shellTool(overrides: Partial<ToolSettingItem> = {}): ToolSettingItem {
      return tool({ toolId: 'shell_exec', allowlist: ['gh *'], ...overrides });
    }

    function openShellDrawer(t: ToolSettingItem, onSaved = jest.fn()) {
      render(<ToolSettingsDrawer tool={t} onSaved={onSaved} trigger={OPEN_TRIGGER} />);
    }

    it('fetches env var names on open and suggests them via datalist [unit]', async () => {
      openShellDrawer(shellTool());
      await waitFor(() => expect(mockEnvNames).toHaveBeenCalledWith());
      expect((await screen.findByText('Environment variables')).parentElement).toBeInTheDocument();
      await waitFor(() => expect(screen.getByLabelText('Add variable name')).toBeInTheDocument());
    });

    it('degrades to free-text-only when the names fetch fails [unit]', async () => {
      mockEnvNames.mockRejectedValue(new Error('offline'));
      openShellDrawer(shellTool());
      const input = await screen.findByLabelText('Add variable name');
      fireEvent.input(input, { target: { value: 'GH_TOKEN' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      // Entry is still addable — no suggestions, but no hard failure either.
      // Falls back to referencing a host var of the same name, shown as the
      // bare name since the row's value field is in env mode.
      expect(
        screen.getByRole('switch', { name: 'Source GH_TOKEN from an environment variable' }),
      ).toBeChecked();
      expect(screen.getByLabelText('GH_TOKEN')).toHaveValue('GH_TOKEN');
    });

    // Issue #220: the input pointed at a datalist id that didn't exist, so
    // name suggestions never appeared.
    it('wires the name input to the suggestions datalist [unit]', async () => {
      openShellDrawer(shellTool());
      const input = await screen.findByLabelText('Add variable name');
      const listId = input.getAttribute('list');
      expect(listId).toBeTruthy();
      expect(document.getElementById(listId!)?.tagName).toBe('DATALIST');
    });

    it('adds an entry via the Add button, falling back to a ${NAME} lookup when untouched [unit]', async () => {
      openShellDrawer(shellTool());
      fireEvent.input(await screen.findByLabelText('Add variable name'), {
        target: { value: 'GH_TOKEN' },
      });
      // The add-row's value field is left untouched — no live preview
      // before Add is clicked, just a sensible fallback once it is.
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      expect(
        screen.getByRole('switch', { name: 'Source GH_TOKEN from an environment variable' }),
      ).toBeChecked();
      expect(screen.getByLabelText('GH_TOKEN')).toHaveValue('GH_TOKEN');
      expect(screen.getByLabelText('Add variable name')).toHaveValue('');
    });

    it('keeps a literal value typed before adding [unit]', async () => {
      openShellDrawer(shellTool());
      fireEvent.input(await screen.findByLabelText('Add variable name'), {
        target: { value: 'TOOLS_DIR' },
      });
      fireEvent.input(screen.getByLabelText('Value'), {
        target: { value: '/opt/tools' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      expect(screen.getByLabelText('TOOLS_DIR')).toHaveValue('/opt/tools');
    });

    // The screenshot in #220 shows "${GH_TOKEN}" typed into the name field.
    it('treats ${NAME} typed as a name as the bare name [unit]', async () => {
      openShellDrawer(shellTool());
      const input = await screen.findByLabelText('Add variable name');
      fireEvent.input(input, { target: { value: '${GH_TOKEN}' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(
        screen.getByRole('switch', { name: 'Source GH_TOKEN from an environment variable' }),
      ).toBeChecked();
      expect(screen.getByLabelText('GH_TOKEN')).toHaveValue('GH_TOKEN');
    });

    it('warns on a lowercase name [unit]', async () => {
      openShellDrawer(shellTool());
      const input = await screen.findByLabelText('Add variable name');
      fireEvent.input(input, { target: { value: 'gh_token' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(screen.getByLabelText('gh_token')).toBeInTheDocument();
      expect(screen.getByText(/uppercase names/i)).toBeInTheDocument();
    });

    it('shows stored values in editable inputs and saves edits [unit]', async () => {
      mockPatch.mockResolvedValue(tool({ toolId: 'shell_exec' }));
      openShellDrawer(shellTool({ env: { GH_TOKEN: '${GH_TOKEN}', PATH: '${HOME}/bin' } }));
      // PATH's value mixes a lookup with literal text ("${HOME}/bin"), so
      // it's not a pure env reference — it stays in literal mode, shown
      // exactly as stored.
      const value = await screen.findByLabelText('PATH');
      expect(value).toHaveValue('${HOME}/bin');
      fireEvent.input(value, { target: { value: '/opt/bin:/usr/bin' } });
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => expect(mockPatch).toHaveBeenCalled());
      expect(mockPatch).toHaveBeenCalledWith(
        'shell_exec',
        expect.objectContaining({
          allowlist: ['gh *'],
          denylist: [],
          env: { GH_TOKEN: '${GH_TOKEN}', PATH: '/opt/bin:/usr/bin' },
        }),
      );
    });

    // With GET returning what config.yaml holds, an empty editor means "no
    // env" — sending {} is what lets the last row actually be removed.
    it('sends an empty env when there are no entries [unit]', async () => {
      mockPatch.mockResolvedValue(tool({ toolId: 'shell_exec' }));
      openShellDrawer(shellTool());
      fireEvent.click(await screen.findByText('Save'));

      await waitFor(() => expect(mockPatch).toHaveBeenCalled());
      expect(mockPatch.mock.calls[0][1]).toHaveProperty('env', {});
    });

    it('removing the last entry saves an empty env, clearing it [unit]', async () => {
      mockPatch.mockResolvedValue(tool({ toolId: 'shell_exec' }));
      openShellDrawer(shellTool({ env: { GH_TOKEN: '${GH_TOKEN}' } }));
      fireEvent.click(await screen.findByLabelText('Remove environment variable GH_TOKEN'));
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => expect(mockPatch).toHaveBeenCalled());
      expect(mockPatch.mock.calls[0][1]).toHaveProperty('env', {});
    });

    it('shows each rejected row error next to that row and keeps the drawer open [unit]', async () => {
      mockPatch.mockRejectedValue(
        new RequestError('1 environment variable is invalid.', 400, {
          'env.PATH': ["PATH: references ${NOPE}, which isn't set in the API's environment."],
        }),
      );
      openShellDrawer(shellTool({ env: { GH_TOKEN: '${GH_TOKEN}', PATH: '${NOPE}' } }));
      fireEvent.click(await screen.findByText('Save'));

      await waitFor(() => expect(screen.getByText(/references \$\{NOPE\}/)).toBeInTheDocument());
      // Only PATH's row shows an error — GH_TOKEN's row has none.
      expect(screen.getAllByText(/references \$\{NOPE\}/)).toHaveLength(1);
      expect(screen.getByText('1 environment variable is invalid.')).toBeInTheDocument();

      // Editing the row clears its error. PATH's value ("${NOPE}") is a
      // pure env reference, so its row renders in env mode — the visible
      // input holds the bare name.
      fireEvent.input(screen.getByLabelText('PATH'), { target: { value: 'HOME' } });
      expect(screen.queryByText(/references \$\{NOPE\}/)).not.toBeInTheDocument();
    });
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
