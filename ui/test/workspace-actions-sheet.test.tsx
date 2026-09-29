import { render, screen } from '@testing-library/preact';
import { fireEvent } from '@testing-library/preact';
import { signal } from '@preact/signals';

import { WorkspaceActionsSheet } from '@/pages/workspaces/workspace-actions-sheet';
import { ThemeProvider } from '@/hooks/use-theme';
import type { Workspace, Project } from '@/services/workspaces-api';

jest.mock('@/pages/workspaces/workspace-settings-drawer', () => ({
  WorkspaceSettingsDrawer: () => <button>Edit</button>,
}));

function baseWorkspace(): Workspace {
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
  };
}

function renderSheet(
  overrides: {
    isTerminal?: boolean;
    isProj?: boolean;
    projectStatus?: Project['status'];
    onSaved?: () => void;
    onCloseIntent?: (intent: 'close' | 'abandon') => void;
    onDelete?: () => void;
  } = {},
) {
  const open = signal(true);
  const onSaved = overrides.onSaved ?? jest.fn();
  const onCloseIntent = overrides.onCloseIntent ?? jest.fn();
  const onDelete = overrides.onDelete ?? jest.fn();

  render(
    <ThemeProvider>
      <WorkspaceActionsSheet
        workspace={baseWorkspace()}
        isTerminal={overrides.isTerminal ?? false}
        isProj={overrides.isProj ?? false}
        projectStatus={overrides.projectStatus}
        onSaved={onSaved}
        onCloseIntent={onCloseIntent}
        onDelete={onDelete}
        open={open}
      />
    </ThemeProvider>,
  );

  return { onSaved, onCloseIntent, onDelete };
}

describe('WorkspaceActionsSheet', () => {
  it('shows Edit when the workspace is not terminal [orchestration]', () => {
    renderSheet({ isTerminal: false });

    expect(screen.getByText('Edit')).toBeInTheDocument();
  });

  it('hides Edit when the workspace is terminal [orchestration]', () => {
    renderSheet({ isTerminal: true });

    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
  });

  it('shows Close/Abandon only for an active project [orchestration]', () => {
    renderSheet({ isProj: true, projectStatus: 'active' });

    expect(screen.getByTestId('actions-close-project')).toBeInTheDocument();
    expect(screen.getByTestId('actions-abandon-project')).toBeInTheDocument();
  });

  it('hides Close/Abandon for a non-project workspace [orchestration]', () => {
    renderSheet({ isProj: false });

    expect(screen.queryByTestId('actions-close-project')).not.toBeInTheDocument();
    expect(screen.queryByTestId('actions-abandon-project')).not.toBeInTheDocument();
  });

  it('hides Close/Abandon for a project that is no longer active [orchestration]', () => {
    renderSheet({ isProj: true, projectStatus: 'closed' });

    expect(screen.queryByTestId('actions-close-project')).not.toBeInTheDocument();
  });

  it('invokes onCloseIntent with the right intent when Close/Abandon are tapped [orchestration]', () => {
    const { onCloseIntent } = renderSheet({ isProj: true, projectStatus: 'active' });

    fireEvent.click(screen.getByTestId('actions-close-project'));
    expect(onCloseIntent).toHaveBeenCalledWith('close');

    fireEvent.click(screen.getByTestId('actions-abandon-project'));
    expect(onCloseIntent).toHaveBeenCalledWith('abandon');
  });

  it('always shows Delete and invokes onDelete when tapped [orchestration]', () => {
    const { onDelete } = renderSheet({ isTerminal: true, isProj: false });

    const deleteButton = screen.getByTestId('actions-delete-workspace');
    expect(deleteButton).toBeInTheDocument();

    fireEvent.click(deleteButton);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('always shows the theme toggle [orchestration]', () => {
    renderSheet();

    expect(screen.getByRole('button', { name: /theme/i })).toBeInTheDocument();
  });
});
