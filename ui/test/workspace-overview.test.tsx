import { render, screen } from '@testing-library/preact';

import { WorkspaceDetailView } from '@/pages/workspaces/[id]';
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
    status: 'active',
    closedAt: null,
  },
};

function seed(workspace: Workspace, project?: WorkspaceWithProject) {
  workspaces.value = [workspace];
  projects.value = project ? [project] : [];
}

function renderDetail() {
  return render(
    <ThemeProvider>
      <WorkspaceDetailView id="ws-1" />
    </ThemeProvider>,
  );
}

describe('WorkspaceDetailView — Overview wiki card', () => {
  afterEach(() => {
    workspaces.value = [];
    projects.value = [];
  });

  it('renders the wiki as a deep link into the wiki document view when wikiId is set', () => {
    seed(baseWorkspace, baseProject);
    renderDetail();

    const link = screen.getByTestId('wiki-link');
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/wiki?view=document&domain=project-ws-1&page=index.md');
    expect(link).toHaveTextContent('project-ws-1');
  });

  it('falls back to "Not linked" when the workspace has no wikiId', () => {
    const workspace = { ...baseWorkspace, wikiId: null };
    seed(workspace, { ...baseProject, wikiId: null });
    renderDetail();

    expect(screen.queryByTestId('wiki-link')).not.toBeInTheDocument();
    expect(screen.getByText('Not linked')).toBeInTheDocument();
  });
});

describe('WorkspaceDetailView — Git chip tooltip', () => {
  afterEach(() => {
    workspaces.value = [];
    projects.value = [];
  });

  it('shows the remote URL as a title attribute on the Git chip when git is enabled', () => {
    const workspace = {
      ...baseWorkspace,
      git: true,
      remoteUrl: 'https://github.com/org/repo',
    };
    seed(workspace, { ...baseProject, git: true, remoteUrl: 'https://github.com/org/repo' });
    renderDetail();

    expect(screen.getByTestId('git-chip')).toHaveAttribute('title', 'https://github.com/org/repo');
  });

  it('omits the Git chip entirely when git is false', () => {
    seed(baseWorkspace, baseProject);
    renderDetail();

    expect(screen.queryByTestId('git-chip')).not.toBeInTheDocument();
  });
});

describe('WorkspaceDetailView — Dependency isolation chips', () => {
  afterEach(() => {
    workspaces.value = [];
    projects.value = [];
  });

  it('shows both chips when javascript and python are both set', () => {
    const workspace = { ...baseWorkspace, javascript: true, python: true };
    seed(workspace, { ...baseProject, javascript: true, python: true });
    renderDetail();

    expect(screen.getByTestId('javascript-chip')).toBeInTheDocument();
    expect(screen.getByTestId('python-chip')).toBeInTheDocument();
  });

  it('shows only the JavaScript chip when only javascript is set', () => {
    const workspace = { ...baseWorkspace, javascript: true, python: false };
    seed(workspace, { ...baseProject, javascript: true, python: false });
    renderDetail();

    expect(screen.getByTestId('javascript-chip')).toBeInTheDocument();
    expect(screen.queryByTestId('python-chip')).not.toBeInTheDocument();
  });

  it('omits both chips when javascript and python are both false', () => {
    seed(baseWorkspace, baseProject);
    renderDetail();

    expect(screen.queryByTestId('javascript-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('python-chip')).not.toBeInTheDocument();
  });
});
