import { render, screen, fireEvent, within, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';

jest.mock('preact-iso', () => ({
  ...jest.requireActual('preact-iso'),
  useLocation: () => ({ url: '/', path: '/', query: {}, route: jest.fn() }),
}));

const mockApiArchiveTask = jest.fn();
const mockApiUnarchiveTask = jest.fn();
jest.mock('@/services/tasks-api', () => ({
  ...jest.requireActual('@/services/tasks-api'),
  fetchTaskRuns: () => Promise.resolve([]),
  listTaskDependencies: () => Promise.resolve([]),
  archiveTask: (...args: unknown[]) => mockApiArchiveTask(...args),
  unarchiveTask: (...args: unknown[]) => mockApiUnarchiveTask(...args),
}));

import { TaskBoard, laneAccepts } from '@/pages/workspaces/task-board/task-board';
import { queueState } from '@/hooks/use-tasks';
import type { Task } from '@/services/tasks-api';
import { boardTask } from './fixtures/board-task';

// jsdom has no `onpointerdown` IDL property, so Preact falls back to
// registering pointer listeners under the un-lowercased event name — needed
// to actually open Radix's pointerdown-driven menus in jsdom. Mirrors
// thread-sidebar.test.tsx's own helper.
function firePointerDown(element: Element) {
  fireEvent(element, new MouseEvent('PointerDown', { bubbles: true, cancelable: true, button: 0 }));
}

function renderBoard(taskList: Task[], showArchived = signal(false)) {
  return render(
    <TaskBoard
      workspaceId="ws-1"
      taskList={taskList}
      onSaved={jest.fn()}
      onGoToChat={jest.fn()}
      showArchived={showArchived}
    />,
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

  it('opens a task that was added after the board mounted (regression) [unit]', () => {
    const { rerender } = renderBoard([]);
    rerender(
      <TaskBoard
        workspaceId="ws-1"
        taskList={[boardTask({ id: 'late', title: 'Added later' }, { lane: 'backlog' })]}
        onSaved={jest.fn()}
        onGoToChat={jest.fn()}
        showArchived={signal(false)}
      />,
    );

    fireEvent.click(screen.getByTestId('task-card'));

    expect(screen.getByDisplayValue('Added later')).toBeInTheDocument();
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

  describe('Show Archived', () => {
    beforeEach(() => {
      mockApiArchiveTask.mockReset();
      mockApiUnarchiveTask.mockReset();
    });

    it('reflects the showArchived signal and flips it when toggled [unit]', () => {
      const showArchived = signal(false);
      renderBoard([], showArchived);

      const toggle = screen.getByTestId('task-board-show-archived');
      expect(toggle).toHaveAttribute('aria-checked', 'false');

      fireEvent.click(toggle);

      expect(showArchived.value).toBe(true);
    });

    it('shows an Archived badge only on an archived Done-lane card [unit]', () => {
      renderBoard([
        boardTask(
          { id: 'a', status: 'done', archivedAt: '2026-10-21T00:00:00.000Z' },
          { lane: 'done' },
        ),
        boardTask({ id: 'b', status: 'done' }, { lane: 'done' }),
      ]);

      const done = document.querySelector('[data-column="done"]') as HTMLElement;
      const cards = within(done).getAllByTestId('task-card');
      expect(within(cards[0]!).getByText('Archived')).toBeInTheDocument();
      expect(within(cards[1]!).queryByText('Archived')).not.toBeInTheDocument();
    });

    it('offers Archive on a non-archived Done-lane card, calling the API on select [unit]', async () => {
      mockApiArchiveTask.mockResolvedValue(
        boardTask({ id: 'a', status: 'done', archivedAt: '2026-10-21T00:00:00.000Z' }),
      );
      renderBoard([boardTask({ id: 'a', status: 'done' }, { lane: 'done' })]);

      firePointerDown(screen.getByRole('button', { name: 'Options for Deploy Infisical' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));

      await waitFor(() => expect(mockApiArchiveTask).toHaveBeenCalledWith('a'));
    });

    it('offers Unarchive on an archived Done-lane card, calling the API on select [unit]', async () => {
      mockApiUnarchiveTask.mockResolvedValue(boardTask({ id: 'a', status: 'done' }));
      renderBoard([
        boardTask(
          { id: 'a', status: 'done', archivedAt: '2026-10-21T00:00:00.000Z' },
          { lane: 'done' },
        ),
      ]);

      firePointerDown(screen.getByRole('button', { name: 'Options for Deploy Infisical' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Unarchive' }));

      await waitFor(() => expect(mockApiUnarchiveTask).toHaveBeenCalledWith('a'));
    });

    it('offers no archive menu outside the Done lane [unit]', () => {
      renderBoard([boardTask({ id: 'a' }, { lane: 'backlog' })]);
      expect(screen.queryByRole('button', { name: /Options for/ })).not.toBeInTheDocument();
    });
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
