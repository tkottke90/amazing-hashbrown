import { render, screen, waitFor } from '@testing-library/preact';

const mockListTaskDependencies = jest.fn();

jest.mock('@/services/tasks-api', () => ({
  ...jest.requireActual('@/services/tasks-api'),
  listTaskDependencies: (...args: unknown[]) => mockListTaskDependencies(...args),
}));

import { TaskCard } from '@/pages/workspaces/[id]';
import { tasks } from '@/hooks/use-tasks';
import type { Task, TaskDependency } from '@/services/tasks-api';

const baseTask: Task = {
  id: 'task-1',
  workspaceId: null,
  title: 'Do the thing',
  description: null,
  outcome: null,
  status: 'pending',
  assignedTo: null,
  dueAt: null,
  expiresAt: null,
  triggerType: 'manual',
  triggerConfig: null,
  trackerType: null,
  trackerId: null,
  plan: null,
  blockedReason: null,
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
};

function makeDep(overrides: Partial<TaskDependency> = {}): TaskDependency {
  return {
    id: 1,
    taskId: 'task-1',
    dependsOnTaskId: 'task-other',
    requireSuccess: true,
    whileBlocked: false,
    createdAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('TaskCard — dependency badge', () => {
  afterEach(() => {
    jest.clearAllMocks();
    tasks.value = [];
  });

  it('shows a "Waiting on" badge when a pending task has an unmet dependency', async () => {
    tasks.value = [{ ...baseTask, id: 'task-other', title: 'Prep work', status: 'running' }];
    mockListTaskDependencies.mockResolvedValue([makeDep()]);

    render(<TaskCard task={baseTask} />);

    await waitFor(() => expect(screen.getByText('Waiting on: Prep work')).toBeInTheDocument());
  });

  it('shows no badge once the dependency is satisfied', async () => {
    tasks.value = [{ ...baseTask, id: 'task-other', title: 'Prep work', status: 'done' }];
    mockListTaskDependencies.mockResolvedValue([makeDep()]);

    render(<TaskCard task={baseTask} />);

    await waitFor(() => expect(mockListTaskDependencies).toHaveBeenCalledWith('task-1'));
    expect(screen.queryByText(/Waiting on:/)).not.toBeInTheDocument();
  });

  it('shows "+N more" when more than one dependency is unmet', async () => {
    tasks.value = [
      { ...baseTask, id: 'task-a', title: 'Alpha task', status: 'running' },
      { ...baseTask, id: 'task-b', title: 'Beta task', status: 'running' },
    ];
    mockListTaskDependencies.mockResolvedValue([
      makeDep({ id: 1, dependsOnTaskId: 'task-b' }),
      makeDep({ id: 2, dependsOnTaskId: 'task-a' }),
    ]);

    render(<TaskCard task={baseTask} />);

    // Alphabetical: "Alpha task" sorts before "Beta task".
    await waitFor(() =>
      expect(screen.getByText('Waiting on: Alpha task +1 more')).toBeInTheDocument(),
    );
  });

  it('never fetches dependencies for a non-pending task', () => {
    render(<TaskCard task={{ ...baseTask, status: 'running' }} />);
    expect(mockListTaskDependencies).not.toHaveBeenCalled();
  });

  it('treats a whileBlocked dependency on a paused target as satisfied', async () => {
    tasks.value = [{ ...baseTask, id: 'task-other', title: 'Prep work', status: 'blocked' }];
    mockListTaskDependencies.mockResolvedValue([makeDep({ whileBlocked: true })]);

    render(<TaskCard task={baseTask} />);

    await waitFor(() => expect(mockListTaskDependencies).toHaveBeenCalledWith('task-1'));
    expect(screen.queryByText(/Waiting on:/)).not.toBeInTheDocument();
  });
});
