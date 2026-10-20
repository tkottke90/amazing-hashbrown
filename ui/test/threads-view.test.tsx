import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/preact';

const mockRoute = jest.fn();
jest.mock('preact-iso', () => ({
  ...jest.requireActual('preact-iso'),
  useLocation: () => ({ url: '/threads', path: '/threads', query: {}, route: mockRoute }),
}));

import { ThreadsView } from '@/pages/threads';
import { allThreads, type ThreadSummary } from '@/hooks/use-thread';
import { ThemeProvider } from '@/hooks/use-theme';

function renderThreadsView() {
  return render(
    <ThemeProvider>
      <ThreadsView />
    </ThemeProvider>,
  );
}

function makeThread(id: string, title: string, type: ThreadSummary['type']): ThreadSummary {
  return {
    id,
    title,
    type,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    forkedFromThreadId: null,
    forkedFromSeq: null,
    afterAgentState: { status: 'idle' },
    links: {
      self: `/api/v1/threads/${id}`,
      afterAgentStatus: `/api/v1/threads/${id}/after-agent-status`,
    },
    provider: null,
    model: null,
    archivedAt: null,
  };
}

const MOCK_THREADS: ThreadSummary[] = [
  makeThread('chat-1', 'A chat conversation', 'chat'),
  makeThread('wiki-1', 'Wiki ingestion', 'wiki'),
  makeThread('ws-chat-1', 'Workspace chat', 'workspace-chat'),
  makeThread('task-1', 'Weekly audit run', 'task'),
  {
    ...makeThread('archived-chat-1', 'Old project planning', 'chat'),
    archivedAt: '2026-10-01T00:00:00.000Z',
  },
];

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = jest.fn().mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/v1/threads?type=all')) {
      return Promise.resolve({ ok: true, json: async () => MOCK_THREADS });
    }
    // Other best-effort calls (e.g. the sidebar's own fetches) just no-op.
    return Promise.resolve({ ok: false, json: async () => [] });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  allThreads.value = [];
  jest.clearAllMocks();
  global.fetch = originalFetch;
});

describe('ThreadsView', () => {
  it('renders a row for every thread type returned by the API [unit]', async () => {
    renderThreadsView();

    await waitFor(() => expect(screen.getAllByTestId('thread-row')).toHaveLength(5));
    expect(screen.getByText('A chat conversation')).toBeInTheDocument();
    expect(screen.getByText('Wiki ingestion')).toBeInTheDocument();
    expect(screen.getByText('Workspace chat')).toBeInTheDocument();
    expect(screen.getByText('Weekly audit run')).toBeInTheDocument();
    expect(screen.getByText('Old project planning')).toBeInTheDocument();
  });

  it('narrows the list when a filter tab is clicked [unit]', async () => {
    renderThreadsView();
    await waitFor(() => expect(screen.getAllByTestId('thread-row')).toHaveLength(5));

    fireEvent.click(screen.getByRole('button', { name: 'Wiki' }));

    expect(screen.getAllByTestId('thread-row')).toHaveLength(1);
    expect(screen.getByText('Wiki ingestion')).toBeInTheDocument();
  });

  it('filters rows by title substring when searching [unit]', async () => {
    renderThreadsView();
    await waitFor(() => expect(screen.getAllByTestId('thread-row')).toHaveLength(5));

    fireEvent.input(screen.getByPlaceholderText('Search'), { target: { value: 'audit' } });

    expect(screen.getAllByTestId('thread-row')).toHaveLength(1);
    expect(screen.getByText('Weekly audit run')).toBeInTheDocument();
  });

  it('shows an empty state when no threads match the filter [unit]', async () => {
    renderThreadsView();
    await waitFor(() => expect(screen.getAllByTestId('thread-row')).toHaveLength(5));

    fireEvent.input(screen.getByPlaceholderText('Search'), { target: { value: 'no such thread' } });

    expect(screen.queryByTestId('thread-row')).not.toBeInTheDocument();
    expect(screen.getByText('No threads found')).toBeInTheDocument();
  });

  it("each row's report button opens that thread's report URL [unit]", async () => {
    const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
    renderThreadsView();
    await waitFor(() => expect(screen.getAllByTestId('thread-row')).toHaveLength(5));

    const row = screen
      .getByText('Weekly audit run')
      .closest('[data-testid="thread-row"]') as HTMLElement;
    fireEvent.click(within(row).getByTitle('Generate thread report'));

    expect(openSpy).toHaveBeenCalledWith('/api/v1/threads/task-1/report', '_blank');
    openSpy.mockRestore();
  });

  it('the Archived filter tab narrows the list to only archived threads [unit]', async () => {
    renderThreadsView();
    await waitFor(() => expect(screen.getAllByTestId('thread-row')).toHaveLength(5));

    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));

    expect(screen.getAllByTestId('thread-row')).toHaveLength(1);
    expect(screen.getByText('Old project planning')).toBeInTheDocument();
  });

  it('shows an Archived badge on an archived row even when the "All" tab is active [unit]', async () => {
    renderThreadsView();
    await waitFor(() => expect(screen.getAllByTestId('thread-row')).toHaveLength(5));

    const row = screen
      .getByText('Old project planning')
      .closest('[data-testid="thread-row"]') as HTMLElement;
    expect(within(row).getByText('Archived')).toBeInTheDocument();
  });

  it('the Actions column only offers Archive/Unarchive for chat-type rows [unit]', async () => {
    renderThreadsView();
    await waitFor(() => expect(screen.getAllByTestId('thread-row')).toHaveLength(5));

    const chatRow = screen
      .getByText('A chat conversation')
      .closest('[data-testid="thread-row"]') as HTMLElement;
    expect(within(chatRow).getByRole('button', { name: 'Archive' })).toBeInTheDocument();

    const wikiRow = screen
      .getByText('Wiki ingestion')
      .closest('[data-testid="thread-row"]') as HTMLElement;
    expect(within(wikiRow).queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    expect(within(wikiRow).queryByRole('button', { name: 'Unarchive' })).not.toBeInTheDocument();
  });

  it('Archive posts to the archive endpoint; Unarchive posts to the unarchive endpoint [unit]', async () => {
    renderThreadsView();
    await waitFor(() => expect(screen.getAllByTestId('thread-row')).toHaveLength(5));

    const chatRow = screen
      .getByText('A chat conversation')
      .closest('[data-testid="thread-row"]') as HTMLElement;
    fireEvent.click(within(chatRow).getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/v1/threads/chat-1/archive',
        expect.objectContaining({ method: 'POST' }),
      ),
    );

    const archivedRow = screen
      .getByText('Old project planning')
      .closest('[data-testid="thread-row"]') as HTMLElement;
    fireEvent.click(within(archivedRow).getByRole('button', { name: 'Unarchive' }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/v1/threads/archived-chat-1/unarchive',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });
});
