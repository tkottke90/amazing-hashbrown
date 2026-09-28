import { reorderableQueue, resolveDrop, tasksByLane } from '@/pages/workspaces/task-board/lanes';
import type { QueueState } from '@/services/tasks-api';
import { boardTask } from './fixtures/board-task';

const emptyQueue: QueueState = { queue: [], running: [] };

function queueOf(...taskIds: string[]): QueueState {
  return {
    running: [],
    queue: taskIds.map((taskId, i) => ({
      id: `q${i}`,
      taskId,
      status: 'pending',
      position: i + 1,
      enqueuedAt: '2026-09-28T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      recoveryAttempts: 0,
      threadId: null,
      summary: null,
      triggerSource: 'manual',
      scheduledFor: null,
      task: null,
    })),
  };
}

describe('task-board lanes', () => {
  describe('tasksByLane', () => {
    it("groups by the server's lane, never by status [unit]", () => {
      // A pending task the server put in Done (a finished schedule) stays there.
      const lanes = tasksByLane([boardTask({ status: 'pending' }, { lane: 'done' })], emptyQueue);
      expect(lanes.done).toHaveLength(1);
      expect(lanes.backlog).toHaveLength(0);
    });

    it('orders the Queue as it will run: the running task, then queue order [unit]', () => {
      const lanes = tasksByLane(
        [
          boardTask({ id: 'second', status: 'ready' }, { lane: 'queue' }),
          boardTask({ id: 'first', status: 'ready' }, { lane: 'queue' }),
          boardTask({ id: 'running', status: 'running' }, { lane: 'queue' }),
        ],
        queueOf('first', 'second'),
      );
      expect(lanes.queue.map((t) => t.id)).toEqual(['running', 'first', 'second']);
    });

    it('orders Scheduled by soonest start [unit]', () => {
      const at = (id: string, nextFireAt: string | null) =>
        boardTask(
          {
            id,
            status: 'scheduled',
            schedule: {
              nextFireAt,
              iterationCount: 0,
              active: true,
              inactiveReason: null,
              lastRunOutcome: null,
            },
          },
          { lane: 'scheduled' },
        );
      const lanes = tasksByLane(
        [
          at('later', '2026-10-05T00:00:00.000Z'),
          at('none', null),
          at('soon', '2026-10-01T00:00:00.000Z'),
        ],
        emptyQueue,
      );
      expect(lanes.scheduled.map((t) => t.id)).toEqual(['soon', 'later', 'none']);
    });

    it('treats a task without a board as Backlog rather than dropping it [unit]', () => {
      const task = { ...boardTask(), board: undefined };
      expect(tasksByLane([task], emptyQueue).backlog).toHaveLength(1);
    });
  });

  describe('resolveDrop', () => {
    const backlogTask = boardTask({ id: 'b1' }, { lane: 'backlog' });
    const a = boardTask({ id: 'a', status: 'ready' }, { lane: 'queue' });
    const b = boardTask({ id: 'b', status: 'ready' }, { lane: 'queue' });
    const c = boardTask({ id: 'c', status: 'ready' }, { lane: 'queue' });
    const running = boardTask({ id: 'r', status: 'running' }, { lane: 'queue' });
    const lanes = tasksByLane([backlogTask, running, a, b, c], queueOf('a', 'b', 'c'));

    it('dropping on another lane moves to that lane [unit]', () => {
      expect(resolveDrop(backlogTask, 'lane:queue', lanes)).toEqual({ to: 'queue' });
    });

    it("dropping on a card in another lane moves to that card's lane, appended [unit]", () => {
      expect(resolveDrop(backlogTask, 'b', lanes)).toEqual({ to: 'queue' });
    });

    it('dropping back on its own lane does nothing [unit]', () => {
      expect(resolveDrop(backlogTask, 'lane:backlog', lanes)).toBeNull();
    });

    it("dropping a queued card on another queued card takes that card's slot [unit]", () => {
      expect(resolveDrop(c, 'a', lanes)).toEqual({ to: 'queue', position: 0 });
    });

    it('dropping a queued card on the Queue lane itself sends it to the end [unit]', () => {
      expect(resolveDrop(a, 'lane:queue', lanes)).toEqual({ to: 'queue', position: 2 });
    });

    it('dropping a queued card where it already is does nothing [unit]', () => {
      expect(resolveDrop(c, 'lane:queue', lanes)).toBeNull();
      expect(resolveDrop(a, 'a', lanes)).toBeNull();
    });

    it('never reorders the running card [unit]', () => {
      expect(resolveDrop(running, 'a', lanes)).toBeNull();
    });

    it('lists only queued, not running, cards as reorderable [unit]', () => {
      expect(reorderableQueue(lanes).map((t) => t.id)).toEqual(['a', 'b', 'c']);
    });
  });
});
