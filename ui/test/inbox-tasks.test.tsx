import { render, screen, fireEvent, waitFor, within } from '@testing-library/preact';

const mockFetchTasks = jest.fn();
const mockApiArchiveTask = jest.fn();
const mockApiUnarchiveTask = jest.fn();
jest.mock('@/services/tasks-api', () => ({
  ...jest.requireActual('@/services/tasks-api'),
  fetchTasks: (...args: unknown[]) => mockFetchTasks(...args),
  archiveTask: (...args: unknown[]) => mockApiArchiveTask(...args),
  unarchiveTask: (...args: unknown[]) => mockApiUnarchiveTask(...args),
}));
jest.mock('preact-iso', () => ({
  ...jest.requireActual('preact-iso'),
  useLocation: () => ({ url: '/inbox', path: '/inbox', query: {}, route: jest.fn() }),
}));

import { InboxView } from '@/pages/inbox';
import { ThemeProvider } from '@/hooks/use-theme';
import { boardTask } from './fixtures/board-task';

function renderInbox() {
  return render(
    <ThemeProvider>
      <InboxView />
    </ThemeProvider>,
  );
}

describe('InboxView — archiving', () => {
  beforeEach(() => {
    mockFetchTasks.mockReset();
    mockApiArchiveTask.mockReset();
    mockApiUnarchiveTask.mockReset();
    mockFetchTasks.mockResolvedValue([]);
  });

  it('requests the normal (decluttered) fetch by default, with Show Archived off [unit]', async () => {
    renderInbox();

    await waitFor(() =>
      expect(mockFetchTasks).toHaveBeenCalledWith({ workspace_id: null, showArchived: false }),
    );
    expect(screen.getByTestId('inbox-show-archived')).toHaveAttribute('aria-checked', 'false');
  });

  it('re-fetches with showArchived: true when the toggle is switched on [unit]', async () => {
    renderInbox();
    await waitFor(() => expect(mockFetchTasks).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('inbox-show-archived'));

    await waitFor(() =>
      expect(mockFetchTasks).toHaveBeenCalledWith({ workspace_id: null, showArchived: true }),
    );
  });

  it('shows an Archived badge and an Unarchive action for an archived Done-lane task [unit]', async () => {
    mockFetchTasks.mockResolvedValue([
      boardTask(
        {
          id: 'a',
          title: 'Audit old server',
          workspaceId: null,
          status: 'done',
          archivedAt: '2026-10-21T00:00:00.000Z',
        },
        { lane: 'done' },
      ),
    ]);
    renderInbox();

    const row = await screen.findByTestId('inbox-task-row');
    expect(within(row).getByText('Archived')).toBeInTheDocument();
    expect(within(row).getByTestId('inbox-task-archive-toggle')).toHaveAttribute(
      'title',
      'Unarchive',
    );
  });

  it('offers Archive for a non-archived Done-lane task, without opening its drawer [unit]', async () => {
    mockApiArchiveTask.mockResolvedValue(
      boardTask(
        { id: 'a', title: 'Audit old server', workspaceId: null, status: 'done' },
        { lane: 'done' },
      ),
    );
    mockFetchTasks.mockResolvedValue([
      boardTask(
        { id: 'a', title: 'Audit old server', workspaceId: null, status: 'done' },
        { lane: 'done' },
      ),
    ]);
    renderInbox();
    const row = await screen.findByTestId('inbox-task-row');

    fireEvent.click(within(row).getByTestId('inbox-task-archive-toggle'));

    await waitFor(() => expect(mockApiArchiveTask).toHaveBeenCalledWith('a'));
    // Every TaskDrawer's dialog stays mounted (just hidden) while closed, so
    // the meaningful check is that it never opened — not that it vanished.
    expect(document.querySelector('dialog[open]')).not.toBeInTheDocument();
  });

  it('shows no archive action for a task outside the Done lane [unit]', async () => {
    mockFetchTasks.mockResolvedValue([
      boardTask(
        { id: 'a', title: 'Set up SMTP', workspaceId: null, status: 'pending' },
        { lane: 'backlog' },
      ),
    ]);
    renderInbox();

    const row = await screen.findByTestId('inbox-task-row');
    expect(within(row).queryByTestId('inbox-task-archive-toggle')).not.toBeInTheDocument();
  });
});
