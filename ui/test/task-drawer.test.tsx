import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/preact';

const mockCancelTask = jest.fn();
const mockPauseTask = jest.fn();
const mockTakeOverTask = jest.fn();
const mockResumeTask = jest.fn();

jest.mock('@/hooks/use-tasks', () => ({
  ...jest.requireActual('@/hooks/use-tasks'),
  cancelTask: (...args: unknown[]) => mockCancelTask(...args),
  pauseTask: (...args: unknown[]) => mockPauseTask(...args),
  takeOverTask: (...args: unknown[]) => mockTakeOverTask(...args),
  resumeTask: (...args: unknown[]) => mockResumeTask(...args),
}));

const mockListTaskDependencies = jest.fn();
const mockAddTaskDependency = jest.fn();
const mockRemoveTaskDependency = jest.fn();

jest.mock('@/services/tasks-api', () => ({
  ...jest.requireActual('@/services/tasks-api'),
  listTaskDependencies: (...args: unknown[]) => mockListTaskDependencies(...args),
  addTaskDependency: (...args: unknown[]) => mockAddTaskDependency(...args),
  removeTaskDependency: (...args: unknown[]) => mockRemoveTaskDependency(...args),
}));

import { TaskDrawer } from '@/components/task-drawer';
import { tasks } from '@/hooks/use-tasks';
import type { Task, TaskDependency } from '@/services/tasks-api';

const baseTask: Task = {
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
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
};

function renderDrawer(task: Task) {
  const result = render(<TaskDrawer task={task} trigger={<button>Open</button>} />);
  fireEvent.click(screen.getByText('Open'));
  return result;
}

// The drawer's own footer also has a "Cancel" button (closes without
// saving) — every panel button lookup is scoped to the action panel itself
// so it never collides with that unrelated button of the same name.
function getPanel() {
  const label =
    screen.queryByText('Running task controls') ??
    screen.queryByText('Paused task controls') ??
    screen.queryByText('Blocked — a dependency failed');
  if (!label) return null;
  return within(label.parentElement as HTMLElement);
}

// A promise the test controls the resolution of, to assert on the
// in-between (loading/disabled) state of an action button.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Every test in this file mounts a TaskDrawer, which always fires this
// fetch on mount when given an existing task — default it to empty so
// tests that don't care about dependencies never see an unhandled
// rejection or a stray "Depends on" list item.
beforeEach(() => {
  mockListTaskDependencies.mockResolvedValue([]);
});

afterEach(() => {
  tasks.value = [];
});

describe('TaskDrawer — running task controls', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders no action panel for a task with no in-flight/parked status', () => {
    renderDrawer({ ...baseTask, status: 'done' });
    expect(getPanel()).toBeNull();
  });

  it('shows Cancel and Take over (no Pause) for a ready task', () => {
    renderDrawer({ ...baseTask, status: 'ready' });
    const panel = getPanel()!;
    expect(panel.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Take over' })).toBeInTheDocument();
    expect(panel.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
  });

  it('shows all three controls for a running task', () => {
    renderDrawer({ ...baseTask, status: 'running' });
    const panel = getPanel()!;
    expect(panel.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Take over' })).toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('shows only Resume for a blocked (paused) task', () => {
    renderDrawer({ ...baseTask, status: 'blocked' });
    expect(screen.getByText('Paused task controls')).toBeInTheDocument();
    const panel = getPanel()!;
    expect(panel.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(panel.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(panel.queryByRole('button', { name: 'Take over' })).not.toBeInTheDocument();
    expect(panel.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('shows only Take over (no Resume) for a task blocked by a failed dependency', () => {
    renderDrawer({ ...baseTask, status: 'blocked', blockedReason: 'dependency_failed' });
    expect(screen.getByText('Blocked — a dependency failed')).toBeInTheDocument();
    expect(screen.queryByText('Paused task controls')).not.toBeInTheDocument();
    const panel = getPanel()!;
    expect(panel.getByRole('button', { name: 'Take over' })).toBeInTheDocument();
    expect(panel.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    expect(panel.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(panel.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('confirms before cancelling, and skips the call if the confirm is dismissed', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
    renderDrawer({ ...baseTask, status: 'running' });

    fireEvent.click(getPanel()!.getByRole('button', { name: 'Cancel' }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(mockCancelTask).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('cancels after confirming', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    mockCancelTask.mockResolvedValue({ ...baseTask, status: 'cancelled' });
    renderDrawer({ ...baseTask, status: 'running' });

    fireEvent.click(getPanel()!.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(mockCancelTask).toHaveBeenCalledWith('task-1'));
  });

  it('confirms Take over while running, but not while merely ready', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    mockTakeOverTask.mockResolvedValue({ ...baseTask, status: 'pending', assignedTo: 'user' });

    renderDrawer({ ...baseTask, status: 'ready' });
    fireEvent.click(getPanel()!.getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(mockTakeOverTask).toHaveBeenCalledWith('task-1'));
    expect(confirmSpy).not.toHaveBeenCalled();

    confirmSpy.mockClear();
    mockTakeOverTask.mockClear();
    cleanup();

    renderDrawer({ ...baseTask, status: 'running' });
    fireEvent.click(getPanel()!.getByRole('button', { name: 'Take over' }));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(mockTakeOverTask).toHaveBeenCalledWith('task-1'));
  });

  it('never confirms for Pause or Resume', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm');
    mockPauseTask.mockResolvedValue({ ...baseTask, status: 'blocked' });
    mockResumeTask.mockResolvedValue({ ...baseTask, status: 'ready' });

    renderDrawer({ ...baseTask, status: 'running' });
    fireEvent.click(getPanel()!.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(mockPauseTask).toHaveBeenCalled());
    expect(confirmSpy).not.toHaveBeenCalled();
    cleanup();

    renderDrawer({ ...baseTask, status: 'blocked' });
    fireEvent.click(getPanel()!.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(mockResumeTask).toHaveBeenCalled());
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('shows a loading label and disables the panel while an action is in flight, then re-enables', async () => {
    const { promise, resolve } = deferred<Task>();
    mockPauseTask.mockReturnValue(promise);
    renderDrawer({ ...baseTask, status: 'running' });

    fireEvent.click(getPanel()!.getByRole('button', { name: 'Pause' }));

    const panelDuring = getPanel()!;
    expect(await panelDuring.findByRole('button', { name: 'Pausing…' })).toBeDisabled();
    expect(panelDuring.getByRole('button', { name: 'Take over' })).toBeDisabled();
    expect(panelDuring.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    resolve({ ...baseTask, status: 'blocked' });

    await waitFor(() => expect(screen.getByText('Paused task controls')).toBeInTheDocument());
  });

  it('updates the panel to reflect the new status once the action resolves', async () => {
    mockPauseTask.mockResolvedValue({ ...baseTask, status: 'blocked' });
    renderDrawer({ ...baseTask, status: 'running' });

    fireEvent.click(getPanel()!.getByRole('button', { name: 'Pause' }));

    await waitFor(() =>
      expect(getPanel()!.getByRole('button', { name: 'Resume' })).toBeInTheDocument(),
    );
    expect(getPanel()!.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
  });
});

describe('TaskDrawer — waiting_on_user banner', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders the waiting-on-user banner instead of the ready/running/blocked action panel', () => {
    renderDrawer({ ...baseTask, status: 'waiting_on_user' });

    expect(getPanel()).toBeNull();
    expect(
      screen.getByText('This task is waiting on your input — go answer it in chat'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to chat' })).toBeInTheDocument();
  });

  it('calls onGoToChat when the banner button is clicked', () => {
    const onGoToChat = jest.fn();
    render(
      <TaskDrawer
        task={{ ...baseTask, status: 'waiting_on_user' }}
        trigger={<button>Open</button>}
        onGoToChat={onGoToChat}
      />,
    );
    fireEvent.click(screen.getByText('Open'));

    fireEvent.click(screen.getByRole('button', { name: 'Go to chat' }));

    expect(onGoToChat).toHaveBeenCalledTimes(1);
  });

  it('still renders the existing action panel, not the banner, for ready/running/blocked tasks (regression guard)', () => {
    renderDrawer({ ...baseTask, status: 'ready' });

    expect(getPanel()).not.toBeNull();
    expect(
      screen.queryByText('This task is waiting on your input — go answer it in chat'),
    ).not.toBeInTheDocument();
  });
});

describe('TaskDrawer — Depends on section', () => {
  afterEach(() => {
    jest.clearAllMocks();
    cleanup();
  });

  it('renders only for a pending task, not for other statuses', () => {
    renderDrawer({ ...baseTask, status: 'ready' });
    expect(screen.queryByText('Depends on')).not.toBeInTheDocument();
    cleanup();

    renderDrawer({ ...baseTask, status: 'pending' });
    expect(screen.getByText('Depends on')).toBeInTheDocument();
  });

  it('lists existing dependencies and lets the user remove one', async () => {
    const dep: TaskDependency = {
      id: 1,
      taskId: 'task-1',
      dependsOnTaskId: 'task-other',
      requireSuccess: true,
      whileBlocked: false,
      createdAt: '2026-08-29T00:00:00.000Z',
    };
    mockListTaskDependencies.mockResolvedValue([dep]);
    mockRemoveTaskDependency.mockResolvedValue(undefined);
    tasks.value = [{ ...baseTask, id: 'task-other', title: 'The other task' }];

    renderDrawer({ ...baseTask, status: 'pending' });

    await waitFor(() => expect(screen.getByText('The other task')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Remove dependency on "The other task"'));

    await waitFor(() => expect(mockRemoveTaskDependency).toHaveBeenCalledWith('task-1', 1));
    await waitFor(() => expect(screen.queryByText('The other task')).not.toBeInTheDocument());
  });

  it('adds a new dependency with the chosen requireSuccess/whileBlocked flags', async () => {
    const newDep: TaskDependency = {
      id: 2,
      taskId: 'task-1',
      dependsOnTaskId: 'task-other',
      requireSuccess: false,
      whileBlocked: true,
      createdAt: '2026-08-29T00:00:00.000Z',
    };
    mockAddTaskDependency.mockResolvedValue(newDep);
    tasks.value = [{ ...baseTask, id: 'task-other', title: 'The other task' }];

    renderDrawer({ ...baseTask, status: 'pending' });

    await waitFor(() => expect(screen.getByTestId('task-dependency-select')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('task-dependency-select'), {
      target: { value: 'task-other' },
    });
    fireEvent.click(screen.getByLabelText('Require success'));
    fireEvent.click(screen.getByLabelText('OK if paused'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(mockAddTaskDependency).toHaveBeenCalledWith('task-1', 'task-other', {
        requireSuccess: false,
        whileBlocked: true,
      }),
    );
  });

  it('excludes the task itself and tasks in other workspaces from the picker', () => {
    tasks.value = [
      { ...baseTask, id: 'task-1', title: 'Self' },
      { ...baseTask, id: 'task-other-ws', workspaceId: 'ws-2', title: 'Other workspace' },
      { ...baseTask, id: 'task-same-ws', workspaceId: null, title: 'Same workspace' },
    ];

    renderDrawer({ ...baseTask, id: 'task-1', status: 'pending', workspaceId: null });

    const select = screen.getByTestId('task-dependency-select') as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((o) => o.textContent);
    expect(optionLabels).not.toContain('Self');
    expect(optionLabels).not.toContain('Other workspace');
    expect(optionLabels).toContain('Same workspace');
  });
});
