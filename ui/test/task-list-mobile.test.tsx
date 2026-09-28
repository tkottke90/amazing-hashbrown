import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/preact';

const mockApiMoveTask = jest.fn();
const mockApiCreateTask = jest.fn();
jest.mock('@/services/tasks-api', () => ({
  ...jest.requireActual('@/services/tasks-api'),
  moveTask: (...args: unknown[]) => mockApiMoveTask(...args),
  createTask: (...args: unknown[]) => mockApiCreateTask(...args),
  fetchQueue: () => Promise.resolve({ queue: [], running: [] }),
  fetchTaskRuns: () => Promise.resolve([]),
  listTaskDependencies: () => Promise.resolve([]),
}));
jest.mock('preact-iso', () => ({
  ...jest.requireActual('preact-iso'),
  useLocation: () => ({ url: '/', path: '/', query: {}, route: jest.fn() }),
}));

import {
  COLLAPSE_STORAGE_KEY,
  TaskListMobile,
} from '@/pages/workspaces/task-board/task-list-mobile';
import { queueState, tasks } from '@/hooks/use-tasks';
import type { Task } from '@/services/tasks-api';
import { boardTask } from './fixtures/board-task';

const waiting = boardTask(
  { id: 'w', title: 'Choose backup target', status: 'waiting_on_user' },
  {
    lane: 'attention',
    moves: [{ to: 'queue', needs: 'reply' }],
    reason: {
      kind: 'waiting_on_user',
      question: 'NAS or MinIO?',
      choices: [
        { label: 'NAS', value: 'NAS' },
        { label: 'MinIO', value: 'MinIO' },
      ],
      allowFreeText: false,
    },
  },
);
const failed = boardTask(
  { id: 'f', title: 'Generate TLS cert', status: 'failed' },
  {
    lane: 'attention',
    moves: [{ to: 'queue', needs: 'none' }],
    reason: { kind: 'failed', summary: 'step-ca unreachable', attempts: 2 },
  },
);
const running = boardTask({ id: 'r', title: 'Deploy', status: 'running' }, { lane: 'queue' });
const ready = boardTask({ id: 'q', title: 'Migrate secrets', status: 'ready' }, { lane: 'queue' });
const backlog = boardTask({ id: 'b', title: 'Set up SMTP' }, { lane: 'backlog' });
const scheduled = boardTask(
  { id: 's', title: 'Rotate credentials', status: 'scheduled', triggerType: 'cron_repeat' },
  { lane: 'scheduled', moves: [{ to: 'queue', needs: 'none' }] },
);
const done = boardTask({ id: 'd', title: 'Audit repo', status: 'done' }, { lane: 'done' });

function renderList(taskList: Task[]) {
  tasks.value = taskList;
  return render(
    <TaskListMobile
      workspaceId="ws-1"
      taskList={taskList}
      onSaved={jest.fn()}
      onGoToChat={jest.fn()}
    />,
  );
}

const sectionOrder = () =>
  Array.from(document.querySelectorAll('[data-section]')).map((el) =>
    el.getAttribute('data-section'),
  );
const section = (name: string) => document.querySelector(`[data-section="${name}"]`) as HTMLElement;

describe('TaskListMobile', () => {
  beforeEach(() => {
    window.localStorage.clear();
    queueState.value = { queue: [], running: [] };
    mockApiMoveTask.mockReset();
    mockApiMoveTask.mockImplementation((id: string) =>
      Promise.resolve(boardTask({ id, status: 'ready' }, { lane: 'queue' })),
    );
    mockApiCreateTask.mockReset();
  });

  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
  });

  it('orders sections by urgency: Needs you, Running, Up next, Scheduled, Finished [unit]', () => {
    renderList([done, scheduled, backlog, ready, running, failed]);
    expect(sectionOrder()).toEqual(['needs_you', 'running', 'up_next', 'scheduled', 'finished']);
  });

  it('lists queued work before the backlog in Up next [unit]', () => {
    renderList([backlog, ready]);
    const titles = within(section('up_next'))
      .getAllByTestId('task-card')
      .map((c) => c.getAttribute('data-task-id'));
    expect(titles).toEqual(['q', 'b']);
  });

  it('hides empty sections [unit]', () => {
    renderList([backlog]);
    expect(sectionOrder()).toEqual(['up_next']);
  });

  it('starts with Finished collapsed [unit]', () => {
    renderList([done]);
    expect(within(section('finished')).queryByTestId('task-card')).not.toBeInTheDocument();
  });

  it('remembers a collapsed section across remounts [unit]', () => {
    renderList([backlog]);
    fireEvent.click(within(section('up_next')).getByTestId('section-toggle'));
    cleanup();

    renderList([backlog]);

    expect(within(section('up_next')).queryByTestId('task-card')).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(COLLAPSE_STORAGE_KEY)!)).toMatchObject({
      up_next: true,
    });
  });

  it('still renders, with the default layout, when storage is unavailable [unit]', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    renderList([backlog, done]);
    expect(within(section('up_next')).getAllByTestId('task-card')).toHaveLength(1);
    expect(within(section('finished')).queryByTestId('task-card')).not.toBeInTheDocument();
  });

  it('retries a failed task in one tap [unit]', async () => {
    renderList([failed]);
    fireEvent.click(screen.getByTestId('card-action-retry'));
    await waitFor(() => expect(mockApiMoveTask).toHaveBeenCalledWith('f', { to: 'queue' }));
  });

  it('runs a scheduled task now in one tap [unit]', async () => {
    renderList([scheduled]);
    fireEvent.click(screen.getByTestId('card-action-run-now'));
    await waitFor(() => expect(mockApiMoveTask).toHaveBeenCalledWith('s', { to: 'queue' }));
  });

  it('shows no action when the server does not allow the move [unit]', () => {
    renderList([{ ...failed, board: { ...failed.board!, moves: [] } }]);
    expect(screen.queryByTestId('card-action-retry')).not.toBeInTheDocument();
  });

  it('answers the agent from the reply sheet with a quick reply [unit]', async () => {
    renderList([waiting]);

    fireEvent.click(screen.getByTestId('card-action-reply'));
    fireEvent.click(await screen.findByRole('button', { name: 'MinIO' }));

    await waitFor(() =>
      expect(mockApiMoveTask).toHaveBeenCalledWith('w', { to: 'queue', reply: 'MinIO' }),
    );
  });

  it('opens the reply sheet when a waiting card itself is tapped [unit]', async () => {
    renderList([waiting]);
    fireEvent.click(screen.getByTestId('task-card'));
    expect(await screen.findByTestId('board-reply-question')).toHaveTextContent('NAS or MinIO?');
  });

  it('quick add creates the task and queues it for the agent [unit]', async () => {
    const created = boardTask(
      { id: 'new', title: 'Renew certs' },
      { moves: [{ to: 'queue', needs: 'none' }] },
    );
    mockApiCreateTask.mockResolvedValue(created);
    renderList([]);

    fireEvent.click(screen.getByTestId('quick-add-button'));
    fireEvent.input(screen.getByLabelText('Task title'), { target: { value: 'Renew certs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(mockApiCreateTask).toHaveBeenCalledWith({
        title: 'Renew certs',
        assignedTo: 'agent',
        workspaceId: 'ws-1',
      }),
    );
    await waitFor(() => expect(mockApiMoveTask).toHaveBeenCalledWith('new', { to: 'queue' }));
  });

  it("quick add for yourself doesn't queue the task [unit]", async () => {
    mockApiCreateTask.mockResolvedValue(
      boardTask({ id: 'new', assignedTo: 'user' }, { moves: [{ to: 'queue', needs: 'reassign' }] }),
    );
    renderList([]);

    fireEvent.click(screen.getByTestId('quick-add-button'));
    fireEvent.input(screen.getByLabelText('Task title'), { target: { value: 'Call ISP' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Me' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(mockApiCreateTask).toHaveBeenCalled());
    expect(mockApiMoveTask).not.toHaveBeenCalled();
  });
});
