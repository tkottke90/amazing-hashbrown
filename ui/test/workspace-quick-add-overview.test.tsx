import { render, screen, fireEvent } from '@testing-library/preact';

const mockRoute = jest.fn();
jest.mock('preact-iso', () => ({
  useLocation: () => ({ url: '/', path: '/', query: {}, route: mockRoute }),
}));

import { WorkspaceDetailView } from '@/pages/workspaces/[id]';
import { ThemeProvider } from '@/hooks/use-theme';
import { workspaces, projects } from '@/hooks/use-workspaces';
import type { Workspace } from '@/services/workspaces-api';

// jest.setup.ts stubs matchMedia to never match — this suite deliberately
// leaves that default in place (no override) so WorkspaceDetailView renders
// its mobile branch, unlike workspace-overview.test.tsx which forces desktop.

const baseWorkspace: Workspace = {
  id: 'ws-1',
  name: 'Infisical Setup',
  description: null,
  goal: null,
  location: '/tmp/projects/infisical-setup',
  managedLocation: true,
  remoteUrl: null,
  javascript: false,
  python: false,
  git: false,
  wikiId: null,
  systemPrompt: null,
  threadId: null,
  summaryPath: null,
  lastSummarizedMessageId: null,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
  lastChange: '2026-08-24T00:00:00.000Z',
};

describe('WorkspaceDetailView — mobile Overview quick-add', () => {
  afterEach(() => {
    workspaces.value = [];
    projects.value = [];
  });

  it('opens the quick-add task sheet from the bottom bar’s "+" while on the Overview tab [orchestration]', () => {
    workspaces.value = [baseWorkspace];
    projects.value = [];

    render(
      <ThemeProvider>
        <WorkspaceDetailView id="ws-1" />
      </ThemeProvider>,
    );

    // The mobile header renders (not the desktop breadcrumb/header), and no
    // tab has been switched away from the default 'overview'.
    expect(screen.getByTestId('workspace-mobile-header')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New task' }));

    expect(screen.getByTestId('quick-add-form')).toBeInTheDocument();
  });
});
