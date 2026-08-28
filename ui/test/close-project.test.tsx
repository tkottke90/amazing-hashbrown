import { render, screen } from '@testing-library/preact';

const mockRoute = jest.fn();
jest.mock('preact-iso', () => ({
  useLocation: () => ({ url: '/', path: '/', query: {}, route: mockRoute }),
}));

import { CloseProjectView } from '@/pages/workspaces/close/[id]';
import { ThemeProvider } from '@/hooks/use-theme';
import { workspaces, projects } from '@/hooks/use-workspaces';
import type { Workspace, WorkspaceWithProject } from '@/services/workspaces-api';

const baseWorkspace: Workspace = {
  id: 'ws-1',
  name: 'My Project',
  description: null,
  goal: null,
  location: '/tmp/projects/my-project',
  remoteUrl: null,
  javascript: false,
  python: false,
  git: false,
  wikiId: 'project-ws-1',
  systemPrompt: null,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
  lastChange: '2026-08-24T00:00:00.000Z',
};

const baseProject: WorkspaceWithProject = {
  ...baseWorkspace,
  project: {
    id: 'ws-1',
    workspaceId: 'ws-1',
    winCondition: 'It ships',
    dueAt: null,
    status: 'closing',
    closedAt: null,
    closeIntent: 'close',
    snapshotPath: null,
    closeProgress: null,
  },
};

function seed(workspace: Workspace, project: WorkspaceWithProject) {
  workspaces.value = [workspace];
  projects.value = [project];
}

function renderClose() {
  return render(
    <ThemeProvider>
      <CloseProjectView id="ws-1" />
    </ThemeProvider>,
  );
}

describe('CloseProjectView — step resumption', () => {
  afterEach(() => {
    workspaces.value = [];
    projects.value = [];
    mockRoute.mockClear();
  });

  it('redirects back to the workspace detail page when the project is not closing', () => {
    seed(baseWorkspace, {
      ...baseProject,
      project: { ...baseProject.project, status: 'active' },
    });
    renderClose();

    expect(mockRoute).toHaveBeenCalledWith('/workspaces/ws-1');
  });

  it('resumes at step 1 (snapshot) when snapshotPath is unset', () => {
    seed(baseWorkspace, baseProject);
    renderClose();

    expect(screen.getByRole('heading', { name: 'Wiki snapshot' })).toBeInTheDocument();
  });

  it('resumes at step 2 (selective merge) once the snapshot has landed', () => {
    seed(baseWorkspace, {
      ...baseProject,
      project: { ...baseProject.project, snapshotPath: '/tmp/projects/my-project/wiki' },
    });
    renderClose();

    expect(screen.getByRole('heading', { name: 'Selective merge' })).toBeInTheDocument();
  });

  it('resumes at step 3 (dependency cleanup) once mergeSelections is set', () => {
    seed(baseWorkspace, {
      ...baseProject,
      project: {
        ...baseProject.project,
        snapshotPath: '/tmp/projects/my-project/wiki',
        closeProgress: { mergeSelections: [] },
      },
    });
    renderClose();

    expect(screen.getByRole('heading', { name: 'Dependency cleanup' })).toBeInTheDocument();
  });

  it('resumes at step 4 (review) once both closeProgress keys are set, with no network calls needed', () => {
    seed(baseWorkspace, {
      ...baseProject,
      project: {
        ...baseProject.project,
        snapshotPath: '/tmp/projects/my-project/wiki',
        closeProgress: {
          mergeSelections: [{ filename: 'entities/learnings.md', targetDomainId: 'user' }],
          dependencySelections: { removeNodeModules: true, removePythonEnv: false },
        },
      },
    });
    renderClose();

    expect(screen.getByRole('heading', { name: 'Review & close' })).toBeInTheDocument();
    expect(screen.getByText(/entities\/learnings\.md/)).toBeInTheDocument();
    expect(screen.getByText('node_modules')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Complete close' })).toBeInTheDocument();
  });

  it('labels the final action "Complete abandonment" when close_intent is abandon', () => {
    seed(baseWorkspace, {
      ...baseProject,
      project: {
        ...baseProject.project,
        closeIntent: 'abandon',
        snapshotPath: '/tmp/projects/my-project/wiki',
        closeProgress: {
          mergeSelections: [],
          dependencySelections: { removeNodeModules: false, removePythonEnv: false },
        },
      },
    });
    renderClose();

    expect(screen.getByRole('button', { name: 'Complete abandonment' })).toBeInTheDocument();
  });

  it('renders the stepper with no clickable step affordance (forward-only)', () => {
    seed(baseWorkspace, baseProject);
    renderClose();

    expect(screen.getByText('1. Wiki snapshot')).toBeInTheDocument();
    expect(screen.getByText('2. Selective merge')).toBeInTheDocument();
    expect(screen.getByText('3. Dependency cleanup')).toBeInTheDocument();
    expect(screen.getByText('4. Review & close')).toBeInTheDocument();
    // Every button on the page belongs to the active step's own panel, not
    // the step list itself — the stepper has no buttons or links.
    for (const label of [
      '1. Wiki snapshot',
      '2. Selective merge',
      '3. Dependency cleanup',
      '4. Review & close',
    ]) {
      const el = screen.getByText(label);
      expect(el.closest('button, a')).toBeNull();
    }
  });
});
