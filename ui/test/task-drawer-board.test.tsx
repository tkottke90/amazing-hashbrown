import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

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

import { signal } from '@preact/signals';
import { TaskDrawer } from '@/components/task-drawer';
import { tasks } from '@/hooks/use-tasks';
import { boardTask } from './fixtures/board-task';

describe('TaskDrawer — Kanban board section', () => {
  beforeEach(() => {
    mockApiMoveTask.mockReset();
    mockApiCreateTask.mockReset();
  });

  it('opens from an `open` signal with no trigger, as the board drives it [unit]', () => {
    const task = boardTask({ title: 'Deploy Infisical' });
    render(<TaskDrawer task={task} open={signal(true)} />);
    expect(screen.getByDisplayValue('Deploy Infisical')).toBeInTheDocument();
  });

  it("follows the list's live copy of the task, so the section updates after a move [unit]", () => {
    const task = boardTask({ status: 'failed' }, { lane: 'attention', moves: [] });
    tasks.value = [task];
    render(<TaskDrawer task={task} open={signal(true)} />);
    expect(screen.queryByTestId('board-action-retry')).not.toBeInTheDocument();

    tasks.value = [
      boardTask(
        { status: 'failed' },
        {
          lane: 'attention',
          moves: [{ to: 'queue', needs: 'none' }],
          reason: { kind: 'failed', summary: null, attempts: 1 },
        },
      ),
    ];

    return waitFor(() => expect(screen.getByTestId('board-action-retry')).toBeInTheDocument());
  });

  it('queues a new task for the agent when "Add to queue" is ticked [unit]', async () => {
    const created = boardTask(
      { id: 'new', title: 'Renew certs' },
      { moves: [{ to: 'queue', needs: 'none' }] },
    );
    mockApiCreateTask.mockResolvedValue(created);
    mockApiMoveTask.mockResolvedValue(created);
    render(<TaskDrawer task={null} open={signal(true)} defaultWorkspaceId="ws-1" />);

    fireEvent.input(screen.getByPlaceholderText('Task title'), {
      target: { value: 'Renew certs' },
    });
    fireEvent.click(screen.getByTestId('task-add-to-queue'));
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));

    await waitFor(() => expect(mockApiMoveTask).toHaveBeenCalledWith('new', { to: 'queue' }));
  });

  it('prefills a new task from a quick-add draft [unit]', () => {
    render(
      <TaskDrawer
        task={null}
        open={signal(true)}
        draft={{ title: 'Call ISP', assignedTo: 'user', addToQueue: false }}
      />,
    );
    expect(screen.getByDisplayValue('Call ISP')).toBeInTheDocument();
    expect((screen.getByTestId('task-add-to-queue') as HTMLInputElement).checked).toBe(false);
  });
});
