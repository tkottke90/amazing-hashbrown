import { buildGreenRoomLanes } from '@/pages/monitoring/green-room';
import type { QueueState, Task } from '@/services/tasks-api';
import type { ProviderActivitySnapshot } from '@tkottke90/llm-common-types/chat';

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
    provider: null,
    model: null,
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

function snapshot(overrides: Partial<ProviderActivitySnapshot> = {}): ProviderActivitySnapshot {
  return { provider: 'ollama', maxConcurrency: 1, active: [], waiting: [], ...overrides };
}

describe('pages/monitoring/green-room', () => {
  it("puts a provider's real waiting callers on its own lane [unit]", () => {
    const snapshots = [
      snapshot({
        provider: 'ollama',
        waiting: [{ threadId: 't-1', kind: 'chat', label: 'Chat: Untitled' }],
      }),
    ];
    const queue: QueueState = { queue: [], running: [] };

    const lanes = buildGreenRoomLanes(snapshots, queue, 'ollama');

    expect(lanes.get('ollama')).toEqual([
      { source: 'live', key: 't-1', label: 'Chat: Untitled', caller: snapshots[0]!.waiting[0] },
    ]);
  });

  it('adds a ready (not-yet-dequeued) task to its Pinned Provider lane [unit]', () => {
    const t = task({ status: 'ready', provider: 'lemonade' });
    const queue: QueueState = { queue: [entry(t)], running: [] };

    const lanes = buildGreenRoomLanes([snapshot({ provider: 'lemonade' })], queue, 'ollama');

    expect(lanes.get('lemonade')).toEqual([
      { source: 'ready', key: 'task-1', label: 'Task: Sync vendor pricing sheet', task: t },
    ]);
  });

  it('falls back to the default provider for a task with no Pinned Provider [unit]', () => {
    const t = task({ status: 'ready', provider: null });
    const queue: QueueState = { queue: [entry(t)], running: [] };

    const lanes = buildGreenRoomLanes([snapshot({ provider: 'ollama' })], queue, 'ollama');

    expect(lanes.get('ollama')).toHaveLength(1);
  });

  it('excludes a running task — only ready tasks are not-yet-dequeued [unit]', () => {
    const t = task({ status: 'running', provider: 'ollama' });
    const queue: QueueState = { queue: [entry(t)], running: [] };

    const lanes = buildGreenRoomLanes([snapshot({ provider: 'ollama' })], queue, 'ollama');

    expect(lanes.get('ollama')).toEqual([]);
  });

  it('pools a real waiting caller and a ready task on the same lane [unit]', () => {
    const t = task({ status: 'ready', provider: 'ollama' });
    const queue: QueueState = { queue: [entry(t)], running: [] };
    const snapshots = [
      snapshot({
        provider: 'ollama',
        waiting: [{ threadId: 't-1', kind: 'task', label: 'Task: Other run' }],
      }),
    ];

    const lanes = buildGreenRoomLanes(snapshots, queue, 'ollama');

    expect(lanes.get('ollama')).toHaveLength(2);
    expect(lanes.get('ollama')!.map((e) => e.source)).toEqual(['live', 'ready']);
  });
});
