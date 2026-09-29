import { render, screen, fireEvent } from '@testing-library/preact';

import { WorkspaceMobileHeader } from '@/pages/workspaces/workspace-mobile-header';
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
    systemPrompt: null,
    threadId: null,
    summaryPath: null,
    lastSummarizedMessageId: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    lastChange: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

function renderHeader(
  overrides: {
    workspace?: Workspace;
    proj?: ReturnType<typeof getProjectForWorkspace>;
    isActive?: boolean;
    isTerminal?: boolean;
    onOpenDetails?: () => void;
    route?: (path: string) => void;
  } = {},
) {
  const onOpenDetails = overrides.onOpenDetails ?? jest.fn();
  const route = overrides.route ?? jest.fn();

  render(
    <WorkspaceMobileHeader
      workspace={overrides.workspace ?? baseWorkspace()}
      proj={overrides.proj}
      isActive={overrides.isActive ?? true}
      isTerminal={overrides.isTerminal ?? false}
      onOpenDetails={onOpenDetails}
      route={route}
    />,
  );

  return { onOpenDetails, route };
}

describe('WorkspaceMobileHeader', () => {
  it('shows the workspace title [unit]', () => {
    renderHeader({ workspace: baseWorkspace({ name: 'Homelab Config' }) });

    expect(screen.getByText('Homelab Config')).toBeInTheDocument();
  });

  it('navigates back to /workspaces when the back arrow is tapped [unit]', () => {
    const { route } = renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Back to workspaces' }));

    expect(route).toHaveBeenCalledWith('/workspaces');
  });

  it('omits the details trigger when the workspace has no git, wiki, or due date [unit]', () => {
    renderHeader({ workspace: baseWorkspace() });

    expect(screen.queryByTestId('mobile-header-details-trigger')).not.toBeInTheDocument();
  });

  it('shows the details trigger when the workspace has git [unit]', () => {
    renderHeader({ workspace: baseWorkspace({ git: true }) });

    expect(screen.getByTestId('mobile-header-details-trigger')).toBeInTheDocument();
  });

  it('calls onOpenDetails once when the icon cluster is tapped, regardless of how many icons show [unit]', () => {
    const { onOpenDetails } = renderHeader({
      workspace: baseWorkspace({ git: true, wikiId: 'homelab' }),
    });

    fireEvent.click(screen.getByTestId('mobile-header-details-trigger'));

    expect(onOpenDetails).toHaveBeenCalledTimes(1);
  });
});
