const mockApiMoveTask = jest.fn();
const mockShowToast = jest.fn();

jest.mock('@/services/tasks-api', () => ({
  ...jest.requireActual('@/services/tasks-api'),
  moveTask: (...args: unknown[]) => mockApiMoveTask(...args),
  fetchQueue: () => new Promise(() => {}), // never settles: keeps the snapshot under test
}));
jest.mock('@/lib/toast', () => ({ showToast: (...args: unknown[]) => mockShowToast(...args) }));

import { movePrompt, performMove, requestMove } from '@/components/task-board/board-move';
import { queueState, tasks } from '@/hooks/use-tasks';
import { RequestError } from '@/utils/fetch.utils';
import type { QueueState, Task } from '@/services/tasks-api';
import { boardTask } from './fixtures/board-task';

function entry(taskId: string, workspaceId: string, status: 'pending' | 'running' = 'pending') {
  return {
    id: `q-${taskId}`,
    taskId,
    status,
    position: 0,
    enqueuedAt: '',
    startedAt: null,
    finishedAt: null,
    recoveryAttempts: 0,
    threadId: null,
    summary: null,
    triggerSource: 'manual' as const,
    scheduledFor: null,
    task: { workspaceId } as Task,
  };
}

describe('components/task-board/board-move', () => {
  beforeEach(() => {
    mockApiMoveTask.mockReset();
    mockShowToast.mockReset();
    movePrompt.value = null;
    queueState.value = { queue: [], running: [] };
  });

  describe('requestMove', () => {
    it('sends a move that needs nothing straight away [unit]', () => {
      const task = boardTask({}, { moves: [{ to: 'queue', needs: 'none' }] });
      tasks.value = [task];
      mockApiMoveTask.mockResolvedValue(task);

      expect(requestMove(task, 'queue')).toBe('moved');
      expect(mockApiMoveTask).toHaveBeenCalledWith('task-1', { to: 'queue' });
    });

    it('opens the start-time picker instead of sending, for a move to Scheduled [unit]', () => {
      const task = boardTask({}, { moves: [{ to: 'scheduled', needs: 'start_time' }] });

      expect(requestMove(task, 'scheduled')).toBe('prompted');
      expect(movePrompt.value).toEqual({ kind: 'start_time', task, to: 'scheduled' });
      expect(mockApiMoveTask).not.toHaveBeenCalled();
    });

    it('asks before handing a task assigned to the user to the agent [unit]', () => {
      const task = boardTask(
        { assignedTo: 'user' },
        { moves: [{ to: 'queue', needs: 'reassign' }] },
      );

      expect(requestMove(task, 'queue', { position: 1 })).toBe('prompted');
      expect(movePrompt.value).toEqual({ kind: 'reassign', task, to: 'queue', position: 1 });
    });

    it("hands a waiting task to the caller's reply UI rather than moving it [unit]", () => {
      const task = boardTask({}, { moves: [{ to: 'queue', needs: 'reply' }] });
      const onReply = jest.fn();

      expect(requestMove(task, 'queue', { onReply })).toBe('reply');
      expect(onReply).toHaveBeenCalledWith(task);
      expect(mockApiMoveTask).not.toHaveBeenCalled();
    });

    it("does nothing for a lane the server doesn't allow [unit]", () => {
      const task = boardTask({}, { moves: [] });
      expect(requestMove(task, 'done')).toBe('not_allowed');
      expect(mockApiMoveTask).not.toHaveBeenCalled();
    });
  });

  describe('performMove', () => {
    it('shows the card in its target lane before the server answers [unit]', async () => {
      const task = boardTask({}, { moves: [{ to: 'queue', needs: 'none' }] });
      tasks.value = [task];
      let resolve!: (t: Task) => void;
      mockApiMoveTask.mockReturnValue(new Promise<Task>((r) => (resolve = r)));

      const pending = performMove(task, { to: 'queue' });

      expect(tasks.value[0]!.board!.lane).toBe('queue');
      resolve(boardTask({ status: 'ready' }, { lane: 'queue' }));
      await expect(pending).resolves.toBe(true);
      expect(tasks.value[0]!.status).toBe('ready');
    });

    it("puts the card back and shows the server's reason when the move is rejected [unit]", async () => {
      const task = boardTask({}, { moves: [{ to: 'queue', needs: 'none' }] });
      tasks.value = [task];
      mockApiMoveTask.mockRejectedValue(new RequestError('The task is no longer queued.', 409));

      await expect(performMove(task, { to: 'queue' })).resolves.toBe(false);

      expect(tasks.value[0]).toBe(task);
      expect(mockShowToast).toHaveBeenCalledWith('error', 'The task is no longer queued.');
    });

    it('shows a success toast only when asked to [unit]', async () => {
      const task = boardTask();
      tasks.value = [task];
      mockApiMoveTask.mockResolvedValue(task);

      await performMove(task, { to: 'queue' }, { successMessage: 'Queued: Deploy' });

      expect(mockShowToast).toHaveBeenCalledWith('success', 'Queued: Deploy');
    });

    it("reorders the queue snapshot within the task's workspace only [unit]", async () => {
      const snapshot: QueueState = {
        running: [],
        queue: [entry('w1', 'ws-1'), entry('other', 'ws-2'), entry('w2', 'ws-1')],
      };
      queueState.value = snapshot;
      const task = boardTask({ id: 'w2', status: 'ready' }, { lane: 'queue' });
      tasks.value = [task];
      mockApiMoveTask.mockReturnValue(new Promise(() => {}));

      void performMove(task, { to: 'queue', position: 0 });

      expect(queueState.value.queue.map((e) => e.taskId)).toEqual(['w2', 'other', 'w1']);
    });

    it('restores the queue snapshot when a reorder is rejected [unit]', async () => {
      const snapshot: QueueState = {
        running: [],
        queue: [entry('a', 'ws-1'), entry('b', 'ws-1')],
      };
      queueState.value = snapshot;
      const task = boardTask({ id: 'b', status: 'ready' }, { lane: 'queue' });
      tasks.value = [task];
      mockApiMoveTask.mockRejectedValue(new Error('nope'));

      await performMove(task, { to: 'queue', position: 0 });

      expect(queueState.value).toBe(snapshot);
    });
  });
});
