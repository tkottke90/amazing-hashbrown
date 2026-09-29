import { render, screen } from '@testing-library/preact';
import { useSignal } from '@preact/signals';

import { WorkspaceDetailsSheet } from '@/pages/workspaces/workspace-details-sheet';
import type { Workspace } from '@/services/workspaces-api';
import type { getProjectForWorkspace } from '@/hooks/use-workspaces';

function baseWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Infisical Setup',
    description: null,
    goal: null,
    location: '/app/config/projects/infisical-setup',
    managedLocation: true,
    git: false,
    remoteUrl: null,
    wikiId: null,
    javascript: false,
    python: false,
    threadId: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  } as Workspace;
}

function Harness({
  workspace,
  proj,
}: {
  workspace: Workspace;
  proj?: ReturnType<typeof getProjectForWorkspace>;
}) {
  const open = useSignal(true);
  return <WorkspaceDetailsSheet workspace={workspace} proj={proj} open={open} />;
}

describe('WorkspaceDetailsSheet', () => {
  it('always shows the location [unit]', () => {
    render(<Harness workspace={baseWorkspace()} />);

    expect(screen.getByTestId('details-location')).toHaveTextContent(
      '/app/config/projects/infisical-setup',
    );
  });

  it('omits git/wiki/language rows when the workspace has none of them [unit]', () => {
    render(<Harness workspace={baseWorkspace()} />);

    expect(screen.queryByTestId('details-git')).not.toBeInTheDocument();
    expect(screen.queryByTestId('details-wiki-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('details-javascript')).not.toBeInTheDocument();
    expect(screen.queryByTestId('details-python')).not.toBeInTheDocument();
    expect(screen.queryByTestId('details-due')).not.toBeInTheDocument();
  });

  it('shows the git row with the remote URL as its title when git is enabled [unit]', () => {
    render(
      <Harness
        workspace={baseWorkspace({ git: true, remoteUrl: 'git@github.com:acme/infra.git' })}
      />,
    );

    expect(screen.getByTestId('details-git')).toHaveAttribute(
      'title',
      'git@github.com:acme/infra.git',
    );
  });

  it('shows the wiki link pointing at the linked domain [unit]', () => {
    render(<Harness workspace={baseWorkspace({ wikiId: 'homelab' })} />);

    expect(screen.getByTestId('details-wiki-link')).toHaveAttribute(
      'href',
      '/wiki?view=document&domain=homelab&page=index.md',
    );
  });

  it('shows JavaScript and Python rows when the workspace has each runtime [unit]', () => {
    render(<Harness workspace={baseWorkspace({ javascript: true, python: true })} />);

    expect(screen.getByTestId('details-javascript')).toBeInTheDocument();
    expect(screen.getByTestId('details-python')).toBeInTheDocument();
  });

  it('shows the due date only when the project has one [unit]', () => {
    const proj: ReturnType<typeof getProjectForWorkspace> = {
      ...baseWorkspace(),
      project: {
        id: 'proj-1',
        workspaceId: 'ws-1',
        winCondition: 'Ship it',
        status: 'active',
        closedAt: null,
        closeIntent: null,
        snapshotPath: null,
        closeProgress: null,
        dueAt: '2026-10-25T00:00:00.000Z',
      },
    };

    render(<Harness workspace={baseWorkspace()} proj={proj} />);

    expect(screen.getByTestId('details-due')).toBeInTheDocument();
  });
});
