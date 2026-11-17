const mockApiPatchTask = jest.fn();
const mockShowToast = jest.fn();

jest.mock('@/services/tasks-api', () => ({
  ...jest.requireActual('@/services/tasks-api'),
  patchTask: (...args: unknown[]) => mockApiPatchTask(...args),
}));
jest.mock('@/lib/toast', () => ({ showToast: (...args: unknown[]) => mockShowToast(...args) }));

import { repinTask } from '@/pages/monitoring/provider-repin';
import { queueState } from '@/hooks/use-tasks';
import type { QueueState, Task } from '@/services/tasks-api';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    workspaceId: null,
    title: 'Sync vendor pricing sheet',
    description: null,
    outcome: null,
    status: 'ready',
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

function entry(t: Task) {
  return {
    id: `q-${t.id}`,
    taskId: t.id,
    status: 'pending' as const,
    position: 0,
    enqueuedAt: '2026-11-16T12:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    recoveryAttempts: 0,
    threadId: null,
    summary: null,
    triggerSource: 'manual' as const,
    scheduledFor: null,
    handoffReason: null,
    task: t,
  };
}

describe('pages/monitoring/provider-repin', () => {
  beforeEach(() => {
    mockApiPatchTask.mockReset();
    mockShowToast.mockReset();
    queueState.value = { queue: [], running: [] };
  });

  it("does nothing for a task that isn't ready (already running) [unit]", async () => {
    const t = task({ status: 'running' });
    queueState.value = { queue: [entry(t)], running: [] };

    const landed = await repinTask(t, 'lemonade');

    expect(landed).toBe(false);
    expect(mockApiPatchTask).not.toHaveBeenCalled();
  });

  it('shows the task re-pinned in the queue snapshot before the server answers [unit]', async () => {
    const t = task({ status: 'ready', provider: 'ollama' });
    queueState.value = { queue: [entry(t)], running: [] };
    let resolve!: (value: Task) => void;
    mockApiPatchTask.mockReturnValue(new Promise<Task>((r) => (resolve = r)));

    const pending = repinTask(t, 'lemonade');

    expect(queueState.value.queue[0]!.task!.provider).toBe('lemonade');
    resolve(task({ status: 'ready', provider: 'lemonade', model: null }));
    await expect(pending).resolves.toBe(true);
    expect(mockApiPatchTask).toHaveBeenCalledWith('task-1', { provider: 'lemonade', model: null });
  });

  it('restores the queue snapshot and shows the error when the PATCH is rejected [unit]', async () => {
    const t = task({ status: 'ready', provider: 'ollama' });
    const snapshot: QueueState = { queue: [entry(t)], running: [] };
    queueState.value = snapshot;
    mockApiPatchTask.mockRejectedValue(new Error('Cannot switch provider while running.'));

    await expect(repinTask(t, 'lemonade')).resolves.toBe(false);

    expect(queueState.value).toBe(snapshot);
    expect(mockShowToast).toHaveBeenCalledWith(
      'error',
      'Cannot switch provider while running.',
    );
  });
});
