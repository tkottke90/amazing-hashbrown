const mockMoveTask = jest.fn();
const mockFetchTask = jest.fn();
const mockFetchQueue = jest.fn(() => Promise.resolve({ queue: [], running: [] }));

jest.mock('@/services/tasks-api', () => ({
  ...jest.requireActual('@/services/tasks-api'),
  moveTask: (...args: unknown[]) => mockMoveTask(...args),
  fetchTask: (...args: unknown[]) => mockFetchTask(...args),
  fetchQueue: () => mockFetchQueue(),
}));

import { moveTask, refreshTask, replaceTask, tasks } from '@/hooks/use-tasks';
import type { Task } from '@/services/tasks-api';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    workspaceId: 'w1',
    title: 'Deploy',
    description: null,
    outcome: null,
    status: 'pending',
    assignedTo: 'agent',
    dueAt: null,
    expiresAt: null,
    triggerType: 'manual',
    triggerConfig: null,
    trackerType: null,
    trackerId: null,
    plan: null,
    blockedReason: null,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    board: { lane: 'backlog', moves: [{ to: 'queue', needs: 'none' }] },
    ...overrides,
  };
}

describe('use-tasks — board moves', () => {
  beforeEach(() => {
    mockMoveTask.mockReset();
    mockFetchTask.mockReset();
    tasks.value = [makeTask(), makeTask({ id: 'task-2', title: 'Other' })];
  });

  it('swaps in the server copy of a moved task, with its new lane [unit]', async () => {
    const moved = makeTask({ status: 'ready', board: { lane: 'queue', moves: [] } });
    mockMoveTask.mockResolvedValue(moved);

    await moveTask('task-1', { to: 'queue' });

    expect(mockMoveTask).toHaveBeenCalledWith('task-1', { to: 'queue' });
    expect(tasks.value[0]).toEqual(moved);
    // Other tasks are untouched.
    expect(tasks.value[1]!.title).toBe('Other');
  });

  it('rethrows a rejected move and leaves the list as it was, so the caller can roll back [unit]', async () => {
    mockMoveTask.mockRejectedValue(new Error('Already in this lane.'));
    const before = tasks.value;

    await expect(moveTask('task-1', { to: 'backlog' })).rejects.toThrow('Already in this lane.');

    expect(tasks.value).toBe(before);
  });

  it('replaceTask restores a single task in place [unit]', () => {
    const original = tasks.value[0]!;
    replaceTask({ ...original, board: { lane: 'queue', moves: [] } });
    replaceTask(original);
    expect(tasks.value[0]).toBe(original);
  });

  it('refreshTask re-fetches one task and swaps it in [unit]', async () => {
    mockFetchTask.mockResolvedValue(makeTask({ status: 'failed' }));

    await refreshTask('task-1');

    expect(tasks.value[0]!.status).toBe('failed');
  });

  it('refreshTask keeps the current copy when the fetch fails [unit]', async () => {
    mockFetchTask.mockRejectedValue(new Error('offline'));
    const before = tasks.value[0];

    await refreshTask('task-1');

    expect(tasks.value[0]).toBe(before);
  });
});
