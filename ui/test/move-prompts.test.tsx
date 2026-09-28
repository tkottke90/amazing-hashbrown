import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

const mockApiMoveTask = jest.fn();
jest.mock('@/services/tasks-api', () => ({
  ...jest.requireActual('@/services/tasks-api'),
  moveTask: (...args: unknown[]) => mockApiMoveTask(...args),
  fetchQueue: () => Promise.resolve({ queue: [], running: [] }),
}));

import { MovePrompts } from '@/components/task-board/move-prompts';
import { movePrompt } from '@/components/task-board/board-move';
import { tasks } from '@/hooks/use-tasks';
import { boardTask } from './fixtures/board-task';

describe('MovePrompts', () => {
  beforeEach(() => {
    mockApiMoveTask.mockReset();
    mockApiMoveTask.mockResolvedValue(boardTask({ status: 'scheduled' }, { lane: 'scheduled' }));
    movePrompt.value = null;
  });

  it('schedules the task at the picked time and closes [unit]', async () => {
    const task = boardTask({}, { moves: [{ to: 'scheduled', needs: 'start_time' }] });
    tasks.value = [task];
    render(<MovePrompts />);

    movePrompt.value = { kind: 'start_time', task, to: 'scheduled' };
    const input = await screen.findByTestId('cron-once-fire-at');
    fireEvent.input(input, { target: { value: '2026-10-04T09:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));

    await waitFor(() => expect(mockApiMoveTask).toHaveBeenCalled());
    const [, request] = mockApiMoveTask.mock.calls[0]!;
    expect(request).toMatchObject({ to: 'scheduled', timezone: expect.any(String) });
    expect(new Date(request.startAt).getTime()).toBe(new Date('2026-10-04T09:00').getTime());
    await waitFor(() => expect(movePrompt.value).toBeNull());
  });

  it('prefills tomorrow at 09:00 when the task has no start time yet [unit]', async () => {
    const task = boardTask();
    render(<MovePrompts />);

    movePrompt.value = { kind: 'start_time', task, to: 'scheduled' };

    const input = (await screen.findByTestId('cron-once-fire-at')) as HTMLInputElement;
    expect(input.value).toMatch(/T09:00$/);
  });

  it('hands a task assigned to you to the agent only after confirmation [unit]', async () => {
    const task = boardTask({ assignedTo: 'user' }, { moves: [{ to: 'queue', needs: 'reassign' }] });
    tasks.value = [task];
    render(<MovePrompts />);

    movePrompt.value = { kind: 'reassign', task, to: 'queue', position: 2 };
    fireEvent.click(await screen.findByRole('button', { name: 'Hand to agent' }));

    await waitFor(() =>
      expect(mockApiMoveTask).toHaveBeenCalledWith('task-1', {
        to: 'queue',
        position: 2,
        assignTo: 'agent',
      }),
    );
  });

  it('Keep it cancels without moving the task [unit]', async () => {
    const task = boardTask({ assignedTo: 'user' });
    render(<MovePrompts />);

    movePrompt.value = { kind: 'reassign', task, to: 'queue' };
    fireEvent.click(await screen.findByRole('button', { name: 'Keep it' }));

    expect(movePrompt.value).toBeNull();
    expect(mockApiMoveTask).not.toHaveBeenCalled();
  });
});
