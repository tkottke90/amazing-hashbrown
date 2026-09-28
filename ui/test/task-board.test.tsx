import { render, screen, fireEvent, within } from '@testing-library/preact';

jest.mock('preact-iso', () => ({
  ...jest.requireActual('preact-iso'),
  useLocation: () => ({ url: '/', path: '/', query: {}, route: jest.fn() }),
}));

jest.mock('@/services/tasks-api', () => ({
  ...jest.requireActual('@/services/tasks-api'),
  fetchTaskRuns: () => Promise.resolve([]),
  listTaskDependencies: () => Promise.resolve([]),
}));

import { TaskBoard, laneAccepts } from '@/pages/workspaces/task-board/task-board';
import { queueState } from '@/hooks/use-tasks';
import type { Task } from '@/services/tasks-api';
import { boardTask } from './fixtures/board-task';

function renderBoard(taskList: Task[]) {
  return render(
    <TaskBoard workspaceId="ws-1" taskList={taskList} onSaved={jest.fn()} onGoToChat={jest.fn()} />,
  );
}

describe('TaskBoard (desktop)', () => {
  beforeEach(() => {
    queueState.value = { queue: [], running: [] };
  });

  it('shows the five lanes in who-acts-next order [unit]', () => {
    renderBoard([]);
    const lanes = screen
      .getAllByRole('region')
      .map((el) => el.getAttribute('data-column'))
      .filter(Boolean);
    expect(lanes).toEqual(['backlog', 'scheduled', 'queue', 'attention', 'done']);
  });

  it("puts each card in the lane the server assigned, with that lane's count [unit]", () => {
    renderBoard([
      boardTask(
        { id: 'a', title: 'Waiting one', status: 'waiting_on_user' },
        { lane: 'attention' },
      ),
      boardTask({ id: 'b', title: 'Failed one', status: 'failed' }, { lane: 'attention' }),
      boardTask({ id: 'c', title: 'Backlog one' }, { lane: 'backlog' }),
    ]);

    const attention = document.querySelector('[data-column="attention"]') as HTMLElement;
    expect(within(attention).getAllByTestId('task-card')).toHaveLength(2);
    expect(within(attention).getByTestId('lane-count')).toHaveTextContent('2');
    expect(
      within(document.querySelector('[data-column="backlog"]') as HTMLElement).getByText(
        'Backlog one',
      ),
    ).toBeInTheDocument();
  });

  it('summarises the workspace: task count and how many are running [unit]', () => {
    renderBoard([
      boardTask({ id: 'a', status: 'running' }, { lane: 'queue' }),
      boardTask({ id: 'b' }, { lane: 'backlog' }),
    ]);
    expect(screen.getByTestId('task-board-summary')).toHaveTextContent('2 tasks · 1 running');
  });

  it('opens the task drawer when a card is clicked [unit]', () => {
    renderBoard([boardTask({ id: 'a', title: 'Deploy Infisical' }, { lane: 'backlog' })]);

    fireEvent.click(screen.getByTestId('task-card'));

    expect(screen.getByDisplayValue('Deploy Infisical')).toBeInTheDocument();
  });

  it('opens the task drawer with Enter, leaving Space for picking the card up [unit]', () => {
    renderBoard([boardTask({ id: 'a', title: 'Deploy Infisical' }, { lane: 'backlog' })]);

    fireEvent.keyDown(screen.getByTestId('task-card'), { key: 'Enter', code: 'Enter' });

    expect(screen.getByDisplayValue('Deploy Infisical')).toBeInTheDocument();
  });

  it('makes a card with at least one legal move keyboard-focusable as a draggable [unit]', () => {
    renderBoard([
      boardTask({ id: 'a' }, { lane: 'backlog', moves: [{ to: 'queue', needs: 'none' }] }),
    ]);
    const card = screen.getByTestId('task-card');
    expect(card).toHaveAttribute('tabindex', '0');
    expect(card).toHaveAttribute('aria-roledescription', 'draggable');
  });
});

describe('laneAccepts', () => {
  it("accepts a lane listed in the card's moves [unit]", () => {
    const task = boardTask({}, { lane: 'backlog', moves: [{ to: 'queue', needs: 'none' }] });
    expect(laneAccepts(task, 'queue')).toBe(true);
  });

  it('rejects a lane the server did not list [unit]', () => {
    const task = boardTask({}, { lane: 'backlog', moves: [{ to: 'queue', needs: 'none' }] });
    expect(laneAccepts(task, 'done')).toBe(false);
  });

  it('accepts the Queue for a queued card, so it can be reordered [unit]', () => {
    const task = boardTask(
      { status: 'ready' },
      { lane: 'queue', moves: [{ to: 'queue', needs: 'none' }] },
    );
    expect(laneAccepts(task, 'queue')).toBe(true);
  });

  it("rejects a card's own lane otherwise, so a drop there is a no-op [unit]", () => {
    const task = boardTask(
      { status: 'scheduled', triggerType: 'cron_once' },
      { lane: 'scheduled', moves: [{ to: 'scheduled', needs: 'start_time' }] },
    );
    expect(laneAccepts(task, 'scheduled')).toBe(false);
  });
});
