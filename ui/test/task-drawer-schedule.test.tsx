import { act, render, screen, fireEvent, waitFor } from '@testing-library/preact';

const mockPatchTask = jest.fn();
const mockPreviewCron = jest.fn();

jest.mock('@/hooks/use-tasks', () => ({
  ...jest.requireActual('@/hooks/use-tasks'),
  patchTask: (...args: unknown[]) => mockPatchTask(...args),
}));

jest.mock('preact-iso', () => ({
  ...jest.requireActual('preact-iso'),
  useLocation: () => ({ url: '/', path: '/', query: {}, route: jest.fn() }),
}));

jest.mock('@/services/tasks-api', () => ({
  ...jest.requireActual('@/services/tasks-api'),
  fetchTaskRuns: () => Promise.resolve([]),
  listTaskDependencies: () => Promise.resolve([]),
  previewCron: (...args: unknown[]) => mockPreviewCron(...args),
}));

import { TaskDrawer } from '@/components/task-drawer';
import type { Task } from '@/services/tasks-api';

const baseTask: Task = {
  id: 'task-1',
  workspaceId: null,
  title: 'Nightly audit',
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
  createdAt: '2026-09-26T00:00:00.000Z',
  updatedAt: '2026-09-26T00:00:00.000Z',
};

const repeatConfig = {
  expression: '0 0 * * *',
  timezone: 'UTC',
  enabled: true,
  maxIterations: null,
  stopAfter: null,
  maxConsecutiveFailures: 3,
  enabledAt: '2026-09-01T00:00:00.000Z',
  lastFiredAt: '2026-09-26T00:00:00.000Z',
  consecutiveFailures: 0,
  pausedReason: null,
};

const validPreview = {
  valid: true,
  description: 'At 12:00 AM',
  nextFireTimes: ['2026-09-27T00:00:00.000Z', '2026-09-28T00:00:00.000Z'],
};

function renderDrawer(task: Task) {
  render(<TaskDrawer task={task} trigger={<button>Open</button>} />);
  fireEvent.click(screen.getByText('Open'));
}

const saveButton = () => screen.getByRole('button', { name: 'Save changes' });

// A raw change event, not fireEvent.change: the testing-library wrapper
// doesn't reach this <select>'s listener with Radix mounted in the drawer
// (the same quirk chat-input.test.tsx documents for file inputs).
function chooseTrigger(value: string) {
  const select = screen.getByTestId('task-trigger-type-select') as HTMLSelectElement;
  select.value = value;
  act(() => {
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('TaskDrawer — scheduled triggers', () => {
  it('keeps Save disabled until a repeat schedule has an expression the server accepts', async () => {
    mockPreviewCron.mockResolvedValue(validPreview);
    renderDrawer(baseTask);
    chooseTrigger('cron_repeat');

    expect(saveButton()).toBeDisabled();

    fireEvent.input(screen.getByTestId('cron-expression'), { target: { value: '0 0 * * *' } });
    expect(saveButton()).toBeDisabled(); // still checking

    await waitFor(() =>
      expect(screen.getByTestId('cron-preview')).toHaveAttribute('data-state', 'valid'),
    );
    expect(screen.getByText('At 12:00 AM')).toBeInTheDocument();
    expect(saveButton()).not.toBeDisabled();
    expect(mockPreviewCron).toHaveBeenCalledWith(
      expect.objectContaining({ expression: '0 0 * * *' }),
      expect.anything(),
    );
  });

  it('shows why an expression is invalid and does not allow saving it', async () => {
    mockPreviewCron.mockResolvedValue({
      valid: false,
      error: 'Use the 5-field form: minute hour day-of-month month day-of-week (got 2 fields).',
      description: '',
      nextFireTimes: [],
    });
    renderDrawer(baseTask);
    chooseTrigger('cron_repeat');
    fireEvent.input(screen.getByTestId('cron-expression'), { target: { value: '* *' } });

    await waitFor(() => expect(screen.getByText(/got 2 fields/)).toBeInTheDocument());
    expect(saveButton()).toBeDisabled();
  });

  it('only asks the server once typing pauses, not on every keystroke', async () => {
    mockPreviewCron.mockResolvedValue(validPreview);
    renderDrawer(baseTask);
    chooseTrigger('cron_repeat');
    const input = screen.getByTestId('cron-expression');
    for (const value of ['0', '0 0', '0 0 *', '0 0 * *', '0 0 * * *']) {
      fireEvent.input(input, { target: { value } });
    }

    await waitFor(() =>
      expect(screen.getByTestId('cron-preview')).toHaveAttribute('data-state', 'valid'),
    );
    expect(mockPreviewCron).toHaveBeenCalledTimes(1);
  });

  it('saves the schedule with its limits as the trigger config', async () => {
    mockPreviewCron.mockResolvedValue(validPreview);
    mockPatchTask.mockImplementation(async (_id: string, patch: Partial<Task>) => ({
      ...baseTask,
      ...patch,
    }));
    renderDrawer(baseTask);
    chooseTrigger('cron_repeat');
    fireEvent.input(screen.getByTestId('cron-expression'), { target: { value: '0 0 * * *' } });
    fireEvent.input(screen.getByTestId('cron-timezone'), {
      target: { value: 'America/Chicago' },
    });
    fireEvent.input(screen.getByTestId('cron-max-iterations'), { target: { value: '10' } });
    fireEvent.input(screen.getByTestId('cron-max-failures'), { target: { value: '' } });

    await waitFor(() => expect(saveButton()).not.toBeDisabled());
    fireEvent.click(saveButton());

    await waitFor(() => expect(mockPatchTask).toHaveBeenCalledTimes(1));
    expect(mockPatchTask.mock.calls[0][1]).toMatchObject({
      triggerType: 'cron_repeat',
      triggerConfig: {
        expression: '0 0 * * *',
        timezone: 'America/Chicago',
        enabled: true,
        maxIterations: 10,
        stopAfter: null,
        maxConsecutiveFailures: null,
      },
    });
  });

  it('opens a saved schedule with its fields filled in and its next run shown', () => {
    mockPreviewCron.mockResolvedValue(validPreview);
    renderDrawer({
      ...baseTask,
      status: 'scheduled',
      triggerType: 'cron_repeat',
      triggerConfig: { ...repeatConfig, maxIterations: 10 },
      schedule: {
        nextFireAt: '2026-09-27T00:00:00.000Z',
        iterationCount: 4,
        active: true,
        inactiveReason: null,
        lastRunOutcome: 'done',
      },
    });

    expect(screen.getByTestId('cron-expression')).toHaveValue('0 0 * * *');
    expect(screen.getByTestId('cron-max-iterations')).toHaveValue(10);
    expect(screen.getByTestId('schedule-enabled')).toBeChecked();
    expect(screen.getByTestId('schedule-next-run')).toHaveTextContent(/^Next run: /);
  });

  it('explains an auto-paused schedule instead of showing a next run', () => {
    mockPreviewCron.mockResolvedValue(validPreview);
    renderDrawer({
      ...baseTask,
      triggerType: 'cron_repeat',
      triggerConfig: {
        ...repeatConfig,
        enabled: false,
        consecutiveFailures: 3,
        pausedReason: 'consecutive_failures',
      },
      schedule: {
        nextFireAt: null,
        iterationCount: 7,
        active: false,
        inactiveReason: 'failures',
        lastRunOutcome: 'failed',
      },
    });

    expect(screen.getByTestId('schedule-inactive-banner')).toHaveTextContent(
      'Paused after 3 consecutive failures',
    );
    expect(screen.getByTestId('schedule-enabled')).not.toBeChecked();
    expect(screen.queryByTestId('schedule-next-run')).not.toBeInTheDocument();
  });

  it('lets a one-shot that already fired be saved without re-checking its (past) time', () => {
    renderDrawer({
      ...baseTask,
      status: 'done',
      triggerType: 'cron_once',
      triggerConfig: {
        fireAt: '2026-09-20T09:00:00.000Z',
        timezone: 'UTC',
        enabled: true,
        enabledAt: '2026-09-01T00:00:00.000Z',
        lastFiredAt: '2026-09-20T09:00:00.000Z',
      },
      schedule: {
        nextFireAt: null,
        iterationCount: 1,
        active: false,
        inactiveReason: 'fired',
        lastRunOutcome: 'done',
      },
    });

    expect(mockPreviewCron).not.toHaveBeenCalled();
    expect(saveButton()).not.toBeDisabled();
    expect(screen.getByTestId('schedule-inactive-banner')).toHaveTextContent(/^Fired on /);
  });

  it("takes a scheduled task off its schedule as 'pending' when switched to manual", async () => {
    mockPreviewCron.mockResolvedValue(validPreview);
    mockPatchTask.mockImplementation(async (_id: string, patch: Partial<Task>) => ({
      ...baseTask,
      ...patch,
    }));
    renderDrawer({
      ...baseTask,
      status: 'scheduled',
      triggerType: 'cron_repeat',
      triggerConfig: repeatConfig,
    });
    chooseTrigger('manual');
    fireEvent.click(saveButton());

    await waitFor(() => expect(mockPatchTask).toHaveBeenCalledTimes(1));
    expect(mockPatchTask.mock.calls[0][1]).toMatchObject({
      triggerType: 'manual',
      status: 'pending',
    });
  });
});
