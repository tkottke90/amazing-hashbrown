const mockCancelTask = jest.fn();
const mockPauseTask = jest.fn();
const mockRefreshQueue = jest.fn();

jest.mock('@/hooks/use-tasks', () => ({
  ...jest.requireActual('@/hooks/use-tasks'),
  cancelTask: (...args: unknown[]) => mockCancelTask(...args),
  pauseTask: (...args: unknown[]) => mockPauseTask(...args),
  refreshQueue: (...args: unknown[]) => mockRefreshQueue(...args),
}));

jest.mock('@/hooks/use-workspaces', () => ({
  ...jest.requireActual('@/hooks/use-workspaces'),
  refreshWorkspaces: jest.fn(),
}));

jest.mock('@/hooks/use-providers', () => ({
  ...jest.requireActual('@/hooks/use-providers'),
  fetchProviders: jest.fn(),
}));

jest.mock('@/components/task-drawer', () => ({
  TaskDrawer: () => null,
}));

import { render, screen, fireEvent } from '@testing-library/preact';
import { TaskQueueMonitor } from '@/pages/monitoring/task-queue-monitor';
import { queueState } from '@/hooks/use-tasks';
import { workspaces } from '@/hooks/use-workspaces';
import type { Task, QueueState } from '@/services/tasks-api';
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

function entry(t: Task, status: 'running' | 'pending' = 'running') {
  return {
    id: `q-${t.id}`,
    taskId: t.id,
    status,
    position: 0,
    enqueuedAt: '2026-11-16T12:00:00.000Z',
    startedAt: status === 'running' ? '2026-11-16T12:00:00.000Z' : null,
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

describe('pages/monitoring/TaskQueueMonitor', () => {
  beforeEach(() => {
    mockCancelTask.mockReset().mockResolvedValue(task());
    mockPauseTask.mockReset().mockResolvedValue(task());
    mockRefreshQueue.mockReset();
    queueState.value = { queue: [], running: [] };
    workspaces.value = [{ id: 'ws-1', name: 'Billing' } as Workspace];
  });

  it('shows the empty state when nothing is in the queue [unit]', () => {
    render(<TaskQueueMonitor />);
    expect(screen.getByText('Nothing in the queue right now.')).toBeInTheDocument();
  });

  it('lists a running task with its workspace name and Running status [unit]', () => {
    const t = task({ status: 'running' });
    const queue: QueueState = { queue: [], running: [entry(t, 'running')] };
    queueState.value = queue;

    render(<TaskQueueMonitor />);

    expect(screen.getByText('Sync vendor pricing sheet')).toBeInTheDocument();
    expect(screen.getByText('Billing')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('lists a ready task as Queued, with no Pause button [unit]', () => {
    const t = task({ status: 'ready' });
    queueState.value = { queue: [entry(t, 'pending')], running: [] };

    render(<TaskQueueMonitor />);

    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('calls pauseTask when Pause is clicked on a running row [unit]', async () => {
    const t = task({ status: 'running' });
    queueState.value = { queue: [], running: [entry(t, 'running')] };

    render(<TaskQueueMonitor />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));

    expect(mockPauseTask).toHaveBeenCalledWith('task-1');
  });

  it('calls cancelTask when Cancel is confirmed [unit]', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    const t = task({ status: 'running' });
    queueState.value = { queue: [], running: [entry(t, 'running')] };

    render(<TaskQueueMonitor />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mockCancelTask).toHaveBeenCalledWith('task-1');
  });

  it('does not call cancelTask when the confirm dialog is dismissed [unit]', () => {
    jest.spyOn(window, 'confirm').mockReturnValue(false);
    const t = task({ status: 'running' });
    queueState.value = { queue: [], running: [entry(t, 'running')] };

    render(<TaskQueueMonitor />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mockCancelTask).not.toHaveBeenCalled();
  });

  it('disables the Pinned Provider switch for a running task, with an explanatory title [unit]', () => {
    const t = task({ status: 'running', provider: 'ollama', model: 'llama3.1' });
    queueState.value = { queue: [], running: [entry(t, 'running')] };

    render(<TaskQueueMonitor />);
    const trigger = screen.getByTitle(
      "Can't switch provider while running — pause or cancel instead.",
    );
    expect(trigger).toBeDisabled();
  });

  it('leaves the Pinned Provider switch interactive for a ready (queued) task [unit]', () => {
    const t = task({ status: 'ready', provider: 'ollama', model: 'llama3.1' });
    queueState.value = { queue: [entry(t, 'pending')], running: [] };

    render(<TaskQueueMonitor />);
    const trigger = screen.getByTitle('Switch provider — takes effect immediately.');
    expect(trigger).not.toBeDisabled();
  });
});
