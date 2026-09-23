const mockRefreshQueue = jest.fn();
const mockRefreshTasks = jest.fn();

jest.mock('@/hooks/use-tasks', () => ({
  ...jest.requireActual('@/hooks/use-tasks'),
  refreshQueue: (...args: unknown[]) => mockRefreshQueue(...args),
  refreshTasks: (...args: unknown[]) => mockRefreshTasks(...args),
}));

const mockHydrate = jest.fn();
const mockUseThreadInstance = jest.fn(() => ({ hydrate: mockHydrate }));

jest.mock('@/hooks/use-thread', () => ({
  ...jest.requireActual('@/hooks/use-thread'),
  useThreadInstance: (...args: unknown[]) => mockUseThreadInstance(...args),
}));

import { connectLiveEvents } from '@/hooks/use-live-events';
import { tasks, queueState } from '@/hooks/use-tasks';
import { activeThreadId } from '@/hooks/use-thread';
import type { Task } from '@/services/tasks-api';

// jsdom has no real EventSource — a minimal fake that captures the handlers
// connectLiveEvents() assigns, so a test can drive them directly.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  emitRaw(data: string) {
    this.onmessage?.({ data });
  }
  open() {
    this.onopen?.();
  }
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    workspaceId: null,
    title: 'Do the thing',
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('hooks/use-live-events', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    (global as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource;
    mockRefreshQueue.mockClear();
    mockRefreshTasks.mockClear();
    mockHydrate.mockClear();
    mockUseThreadInstance.mockClear();
    tasks.value = [];
    queueState.value = { queue: [], running: [] };
    activeThreadId.value = 'thread-inactive';
  });

  function currentSource(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
  }

  it('opens exactly one EventSource against /api/v1/events', () => {
    connectLiveEvents();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(currentSource().url).toBe('/api/v1/events');
  });

  it('returns the EventSource so the caller can close it', () => {
    const es = connectLiveEvents();
    es.close();
    expect(currentSource().closed).toBe(true);
  });

  it('triggers a reconciliation fetch on open (including on reconnect)', () => {
    connectLiveEvents();
    currentSource().open();
    expect(mockRefreshQueue).toHaveBeenCalledTimes(1);
    expect(mockRefreshTasks).toHaveBeenCalledTimes(1);

    // Simulates EventSource's own auto-reconnect firing onopen again.
    currentSource().open();
    expect(mockRefreshQueue).toHaveBeenCalledTimes(2);
    expect(mockRefreshTasks).toHaveBeenCalledTimes(2);
  });

  it('sets queueState directly from a task_queue_update event, with no fetch', () => {
    connectLiveEvents();
    const payload = {
      type: 'task_queue_update' as const,
      queue: [],
      running: [
        {
          id: 'q1',
          taskId: 'task-1',
          status: 'running' as const,
          position: 1,
          enqueuedAt: '2026-01-01T00:00:00.000Z',
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: null,
          recoveryAttempts: 0,
          pauseReason: null,
          pausedAt: null,
          task: makeTask(),
        },
      ],
    };

    currentSource().emit(payload);

    expect(queueState.value).toEqual({ queue: payload.queue, running: payload.running });
    expect(mockRefreshQueue).not.toHaveBeenCalled();
  });

  it('patches the matching task to the given outcome on task_completed, leaving others untouched', () => {
    tasks.value = [
      makeTask({ id: 'task-1', status: 'running' }),
      makeTask({ id: 'task-2', status: 'running' }),
    ];
    connectLiveEvents();

    currentSource().emit({
      type: 'task_completed',
      threadId: 'thread-inactive',
      taskId: 'task-1',
      outcome: 'done',
    });

    expect(tasks.value.find((t) => t.id === 'task-1')!.status).toBe('done');
    expect(tasks.value.find((t) => t.id === 'task-2')!.status).toBe('running');
  });

  it('patches the matching task to waiting_on_user on hitl_prompt', () => {
    tasks.value = [makeTask({ id: 'task-1', status: 'running' })];
    connectLiveEvents();

    currentSource().emit({ type: 'hitl_prompt', threadId: 'thread-inactive', taskId: 'task-1' });

    expect(tasks.value.find((t) => t.id === 'task-1')!.status).toBe('waiting_on_user');
  });

  it('rehydrates the thread only when the event matches the currently active thread', () => {
    tasks.value = [makeTask({ id: 'task-1' })];
    activeThreadId.value = 'thread-A';
    connectLiveEvents();

    currentSource().emit({ type: 'hitl_prompt', threadId: 'thread-B', taskId: 'task-1' });
    expect(mockUseThreadInstance).not.toHaveBeenCalled();
    expect(mockHydrate).not.toHaveBeenCalled();

    currentSource().emit({ type: 'hitl_prompt', threadId: 'thread-A', taskId: 'task-1' });
    expect(mockUseThreadInstance).toHaveBeenCalledWith('thread-A');
    expect(mockHydrate).toHaveBeenCalledTimes(1);
  });

  it('silently ignores a payload that fails schema validation', () => {
    connectLiveEvents();
    expect(() => currentSource().emit({ type: 'not_a_real_event' })).not.toThrow();
    expect(tasks.value).toEqual([]);
    expect(queueState.value).toEqual({ queue: [], running: [] });
  });

  it('silently ignores a payload that is not valid JSON', () => {
    connectLiveEvents();
    expect(() => currentSource().emitRaw('not json')).not.toThrow();
  });
});
