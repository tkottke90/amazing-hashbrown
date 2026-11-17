import { buildTaskQueueRows, formatElapsed } from '@/pages/monitoring/task-queue-rows';
import type { QueueState, Task, TaskQueueEntry } from '@/services/tasks-api';
import type { Workspace } from '@/services/workspaces-api';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    workspaceId: 'ws-1',
    title: 'Sync vendor pricing sheet',
    description: null,
    outcome: null,
    status: 'running',
    assignedTo: 'agent',
    dueAt: null,
    expiresAt: null,
    triggerType: 'manual',
    triggerConfig: null,
    trackerType: null,
    trackerId: null,
    plan: null,
    blockedReason: null,
    provider: 'ollama',
    model: 'llama3.1',
    archivedAt: null,
    createdAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
    ...overrides,
  };
}

function entry(overrides: Partial<TaskQueueEntry> = {}, t: Task | null = task()): TaskQueueEntry & {
  task: Task | null;
} {
  return {
    id: 'q-1',
    taskId: 'task-1',
    status: 'running',
    position: 0,
    enqueuedAt: '2026-11-16T12:00:00.000Z',
    startedAt: '2026-11-16T12:00:05.000Z',
    finishedAt: null,
    recoveryAttempts: 0,
    threadId: null,
    summary: null,
    triggerSource: 'manual',
    scheduledFor: null,
    handoffReason: null,
    ...overrides,
    task: t,
  };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Billing',
    location: '/tmp/ws-1',
    threadId: null,
    ...overrides,
  } as Workspace;
}

describe('pages/monitoring/task-queue-rows', () => {
  describe('formatElapsed', () => {
    it('formats minutes and zero-padded seconds [unit]', () => {
      expect(formatElapsed(25_000)).toBe('0m 25s');
      expect(formatElapsed(245_000)).toBe('4m 05s');
      expect(formatElapsed(1_122_000)).toBe('18m 42s');
    });

    it('clamps a negative duration to 0m 00s [unit]', () => {
      expect(formatElapsed(-500)).toBe('0m 00s');
    });
  });

  describe('buildTaskQueueRows', () => {
    it('includes a running entry with its elapsed time computed from startedAt [unit]', () => {
      const now = new Date('2026-11-16T12:00:30.000Z').getTime();
      const queue: QueueState = { queue: [], running: [entry({}, task({ status: 'running' }))] };

      const rows = buildTaskQueueRows(queue, [workspace()], now);

      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('running');
      expect(rows[0]!.elapsedMs).toBe(25_000);
    });

    it('includes a ready (queued) entry with its elapsed time computed from enqueuedAt [unit]', () => {
      const now = new Date('2026-11-16T12:00:40.000Z').getTime();
      const t = task({ status: 'ready' });
      const queue: QueueState = {
        queue: [entry({ status: 'pending', startedAt: null }, t)],
        running: [],
      };

      const rows = buildTaskQueueRows(queue, [workspace()], now);

      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('ready');
      expect(rows[0]!.elapsedMs).toBe(40_000);
    });

    it('excludes a blocked task even though its queue row is still present [unit]', () => {
      const queue: QueueState = {
        queue: [entry({ status: 'paused' }, task({ status: 'blocked' }))],
        running: [],
      };

      expect(buildTaskQueueRows(queue, [workspace()])).toHaveLength(0);
    });

    it('excludes an entry with no joined task', () => {
      const queue: QueueState = { queue: [entry({}, null)], running: [] };
      expect(buildTaskQueueRows(queue, [workspace()])).toHaveLength(0);
    });

    it('resolves the workspace name from the given workspace list [unit]', () => {
      const queue: QueueState = { queue: [], running: [entry({}, task({ workspaceId: 'ws-1' }))] };
      const rows = buildTaskQueueRows(queue, [workspace({ id: 'ws-1', name: 'Finance Ops' })]);

      expect(rows[0]!.workspaceName).toBe('Finance Ops');
    });

    it("falls back to 'Inbox' for a workspace-less task [unit]", () => {
      const queue: QueueState = {
        queue: [],
        running: [entry({}, task({ workspaceId: null }))],
      };
      expect(buildTaskQueueRows(queue, [workspace()])[0]!.workspaceName).toBe('Inbox');
    });

    it("falls back to 'Inbox' when the task's workspace no longer exists [unit]", () => {
      const queue: QueueState = {
        queue: [],
        running: [entry({}, task({ workspaceId: 'deleted-ws' }))],
      };
      expect(buildTaskQueueRows(queue, [workspace({ id: 'ws-1' })])[0]!.workspaceName).toBe(
        'Inbox',
      );
    });
  });
});
