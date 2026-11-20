import { render, screen, waitFor, fireEvent } from '@testing-library/preact';
import { ThemeProvider } from '@/hooks/use-theme';

jest.mock('@/hooks/use-skills-panel', () => {
  const actual = jest.requireActual('@/hooks/use-skills-panel');
  return {
    ...actual,
    saveSkillDetails: jest.fn(),
    deleteSkillAction: jest.fn(),
  };
});
jest.mock('@/services/tool-settings-api', () => ({
  fetchToolSettings: jest.fn(),
}));

import { SkillDetailsTab } from '@/pages/settings/skill-details-tab';
import * as panelHook from '@/hooks/use-skills-panel';
import * as toolSettingsApi from '@/services/tool-settings-api';
import type { SkillDetail } from '@/services/skills-manage-api';
import type { ToolSettingItem } from '@/services/tool-settings-api';

const mockSaveSkillDetails = panelHook.saveSkillDetails as jest.MockedFunction<
  typeof panelHook.saveSkillDetails
>;
const mockDeleteSkillAction = panelHook.deleteSkillAction as jest.MockedFunction<
  typeof panelHook.deleteSkillAction
>;
const mockFetchToolSettings = toolSettingsApi.fetchToolSettings as jest.MockedFunction<
  typeof toolSettingsApi.fetchToolSettings
>;

function skillDetail(overrides: Partial<SkillDetail> = {}): SkillDetail {
  return {
    name: 'create-workspace',
    slashCommand: '/create-workspace',
    enabled: true,
    path: 'create-workspace',
    frontmatter: {
      name: 'create-workspace',
      description: 'Create a new workspace conversationally.',
    },
    body: 'Guide the user through creating a workspace.',
    scripts: {},
    references: {},
    ...overrides,
  };
}

function tool(overrides: Partial<ToolSettingItem> = {}): ToolSettingItem {
  return {
    toolId: 'create_workspace',
    name: 'Create Workspace',
    description: 'Create a new workspace.',
    category: 'skill-gated',
    alwaysOn: false,
    mcpServer: null,
    lastSeenAt: null,
    lastStatus: null,
    enabled: true,
    defaultInclude: { chat: false, subAgent: false, autonomous: false },
    instructions: '',
    ...overrides,
  };
}

// CodeEditor (rendered by SkillDetailsTab for the skill body) reads the
// active theme via useTheme(), which throws outside a ThemeProvider — same
// requirement code-editor.test.tsx/files-tab.test.tsx already have.
function renderSkill(skill: SkillDetail) {
  return render(
    <ThemeProvider>
      <SkillDetailsTab skill={skill} />
    </ThemeProvider>,
  );
}

describe('SkillDetailsTab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSaveSkillDetails.mockResolvedValue(true);
    mockDeleteSkillAction.mockResolvedValue(true);
  });

  it('renders the skill name, description, and license fields', () => {
    mockFetchToolSettings.mockResolvedValue([]);
    const skill = skillDetail({ frontmatter: { ...skillDetail().frontmatter, license: 'MIT' } });
    renderSkill(skill);

    expect(screen.getByDisplayValue('create-workspace')).toBeInTheDocument();
    expect(
      screen.getByDisplayValue('Create a new workspace conversationally.'),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue('MIT')).toBeInTheDocument();
  });

  it("pre-selects the skill's declared tools once the catalog loads", async () => {
    mockFetchToolSettings.mockResolvedValue([
      tool({ toolId: 'create_workspace', name: 'Create Workspace' }),
      tool({ toolId: 'create_project', name: 'Create Project' }),
    ]);
    const skill = skillDetail({
      frontmatter: { ...skillDetail().frontmatter, tools: 'create_workspace' },
    });
    renderSkill(skill);
    await waitFor(() => expect(screen.getByText('Create Workspace')).toBeInTheDocument());

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    const createWorkspaceCheckbox = screen
      .getByText('Create Workspace')
      .closest('label')
      ?.querySelector('[role="checkbox"]');
    const createProjectCheckbox = screen
      .getByText('Create Project')
      .closest('label')
      ?.querySelector('[role="checkbox"]');
    expect(createWorkspaceCheckbox).toHaveAttribute('aria-checked', 'true');
    expect(createProjectCheckbox).toHaveAttribute('aria-checked', 'false');
  });

  it('flags a selected tool id that is absent from the fetched catalog as unknown', async () => {
    mockFetchToolSettings.mockResolvedValue([
      tool({ toolId: 'create_workspace', name: 'Create Workspace' }),
    ]);
    const skill = skillDetail({
      frontmatter: {
        ...skillDetail().frontmatter,
        tools: 'create_workspace,some_removed_tool',
      },
    });
    renderSkill(skill);

    await waitFor(() => expect(screen.getByText(/Unknown tool/)).toBeInTheDocument());
    expect(screen.getByText('Unknown tool: some_removed_tool')).toBeInTheDocument();
  });

  it('renders a disabled catalog tool grayed out with its disabled label', async () => {
    mockFetchToolSettings.mockResolvedValue([
      tool({
        toolId: 'n8n:workflow_search',
        name: 'Workflow Search',
        category: 'mcp',
        mcpServer: 'n8n',
        enabled: false,
      }),
    ]);
    const skill = skillDetail();
    renderSkill(skill);

    await waitFor(() => expect(screen.getByText('Workflow Search')).toBeInTheDocument());
    expect(screen.getByText("(disabled — won't take effect)")).toBeInTheDocument();
    const row = screen.getByText('Workflow Search').closest('label');
    expect(row?.className).toContain('opacity-40');
  });

  it('saves the updated tools selection as a comma-joined string', async () => {
    mockFetchToolSettings.mockResolvedValue([
      tool({ toolId: 'create_workspace', name: 'Create Workspace' }),
      tool({ toolId: 'create_project', name: 'Create Project' }),
    ]);
    const skill = skillDetail({
      frontmatter: { ...skillDetail().frontmatter, tools: 'create_workspace' },
    });
    renderSkill(skill);
    await waitFor(() => expect(screen.getByText('Create Project')).toBeInTheDocument());

    const createProjectCheckbox = screen
      .getByText('Create Project')
      .closest('label')
      ?.querySelector('[role="checkbox"]') as HTMLElement;
    fireEvent.click(createProjectCheckbox);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockSaveSkillDetails).toHaveBeenCalled());
    expect(mockSaveSkillDetails).toHaveBeenCalledWith(
      'create-workspace',
      expect.objectContaining({ tools: 'create_workspace,create_project' }),
    );
  });

  it('disables Delete and never calls deleteSkillAction for a gated skill', () => {
    mockFetchToolSettings.mockResolvedValue([]);
    const skill = skillDetail({
      frontmatter: { ...skillDetail().frontmatter, tools: 'create_workspace' },
    });
    renderSkill(skill);

    const deleteButton = screen.getByRole('button', { name: 'Delete' });
    expect(deleteButton).toBeDisabled();
    expect(deleteButton).toHaveAttribute('title', 'Required by tool-gating — cannot be deleted');

    fireEvent.click(deleteButton);
    expect(mockDeleteSkillAction).not.toHaveBeenCalled();
  });

  it('enables Delete and calls deleteSkillAction after confirmation for a non-gated skill', () => {
    mockFetchToolSettings.mockResolvedValue([]);
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const skill = skillDetail();
    renderSkill(skill);

    const deleteButton = screen.getByRole('button', { name: 'Delete' });
    expect(deleteButton).not.toBeDisabled();

    fireEvent.click(deleteButton);

    expect(confirmSpy).toHaveBeenCalled();
    expect(mockDeleteSkillAction).toHaveBeenCalledWith('create-workspace');
    confirmSpy.mockRestore();
  });
});
