import { act, render, screen, fireEvent, waitFor } from '@testing-library/preact';

const mockApiMoveTask = jest.fn();
jest.mock('@/services/tasks-api', () => ({
  ...jest.requireActual('@/services/tasks-api'),
  moveTask: (...args: unknown[]) => mockApiMoveTask(...args),
  fetchQueue: () => Promise.resolve({ queue: [], running: [] }),
}));

import { BoardCallout } from '@/components/task-board/board-callout';
import { movePrompt } from '@/components/task-board/board-move';
import { tasks } from '@/hooks/use-tasks';
import { boardTask } from './fixtures/board-task';

// The drawer's board section: every button is a board move, and a button
// only appears when the server lists that move for the task.
describe('BoardCallout', () => {
  beforeEach(() => {
    mockApiMoveTask.mockReset();
    mockApiMoveTask.mockImplementation((_id: string, move: { to: string }) =>
      Promise.resolve(boardTask({}, { lane: move.to as never })),
    );
    movePrompt.value = null;
  });

  it('retries a failed task by moving it to the Queue [unit]', async () => {
    const task = boardTask(
      { status: 'failed' },
      {
        lane: 'attention',
        moves: [{ to: 'queue', needs: 'none' }],
        reason: { kind: 'failed', summary: 'step-ca unreachable', attempts: 2 },
      },
    );
    tasks.value = [task];
    render(<BoardCallout task={task} />);

    expect(screen.getByText(/step-ca unreachable/)).toHaveTextContent('2 attempts');
    fireEvent.click(screen.getByTestId('board-action-retry'));

    await waitFor(() => expect(mockApiMoveTask).toHaveBeenCalledWith('task-1', { to: 'queue' }));
  });

  it('hides Retry when the server does not allow moving the task to the Queue [unit]', () => {
    const task = boardTask(
      { status: 'failed' },
      { lane: 'attention', moves: [], reason: { kind: 'failed', summary: null, attempts: 1 } },
    );
    render(<BoardCallout task={task} />);
    expect(screen.queryByTestId('board-action-retry')).not.toBeInTheDocument();
  });

  it('offers Run now and Reschedule on a scheduled task [unit]', () => {
    const task = boardTask(
      { status: 'scheduled', triggerType: 'cron_once' },
      {
        lane: 'scheduled',
        moves: [
          { to: 'queue', needs: 'none' },
          { to: 'scheduled', needs: 'start_time' },
        ],
      },
    );
    render(<BoardCallout task={task} />);

    fireEvent.click(screen.getByTestId('board-action-reschedule'));

    expect(screen.getByTestId('board-action-run-now')).toBeInTheDocument();
    expect(movePrompt.value).toMatchObject({ kind: 'start_time', to: 'scheduled' });
  });

  it("answers the agent's question with a quick reply, which re-queues the task [unit]", async () => {
    const task = boardTask(
      { status: 'waiting_on_user' },
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
    tasks.value = [task];
    render(<BoardCallout task={task} />);

    fireEvent.click(screen.getByRole('button', { name: 'MinIO' }));

    await waitFor(() =>
      expect(mockApiMoveTask).toHaveBeenCalledWith('task-1', { to: 'queue', reply: 'MinIO' }),
    );
  });

  it("lists exactly the server's allowed destinations in Move to, minus the current lane [unit]", () => {
    const task = boardTask(
      {},
      {
        lane: 'backlog',
        moves: [
          { to: 'scheduled', needs: 'start_time' },
          { to: 'queue', needs: 'none' },
          { to: 'done', needs: 'none' },
        ],
      },
    );
    render(<BoardCallout task={task} />);

    const options = Array.from(
      (screen.getByTestId('board-move-to') as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(options).toEqual(['', 'scheduled', 'queue', 'done']);
  });

  it('sends the chosen Move to destination [unit]', async () => {
    const task = boardTask({}, { lane: 'backlog', moves: [{ to: 'done', needs: 'none' }] });
    tasks.value = [task];
    render(<BoardCallout task={task} />);

    // A raw change event, as in task-drawer-schedule.test.tsx: fireEvent.change
    // doesn't reach a Preact <select>'s listener here.
    const select = screen.getByTestId('board-move-to') as HTMLSelectElement;
    select.value = 'done';
    act(() => {
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await waitFor(() => expect(mockApiMoveTask).toHaveBeenCalledWith('task-1', { to: 'done' }));
  });
});
