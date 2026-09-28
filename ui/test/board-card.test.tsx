import { render, screen } from '@testing-library/preact';
import { BoardCard } from '@/pages/workspaces/task-board/board-card';
import { boardTask } from './fixtures/board-task';

// The card is the board's whole display contract: the exact status survives
// the lane grouping as a badge, and the server's `reason` becomes the one
// line that says why the card is where it is.
describe('BoardCard', () => {
  it('shows the exact status as a badge, since lanes group several statuses [unit]', () => {
    render(<BoardCard task={boardTask({ status: 'waiting_on_user' })} />);
    expect(screen.getByTestId('task-card-status')).toHaveTextContent('Waiting on you');
    expect(screen.getByTestId('task-card')).toHaveAttribute('data-status', 'waiting_on_user');
  });

  it("shows the agent's question on a waiting card [unit]", () => {
    render(
      <BoardCard
        task={boardTask(
          { status: 'waiting_on_user' },
          {
            reason: {
              kind: 'waiting_on_user',
              question: 'NAS or MinIO?',
              choices: [],
              allowFreeText: true,
            },
          },
        )}
      />,
    );
    expect(screen.getByTestId('task-card-reason')).toHaveTextContent('Asks: NAS or MinIO?');
  });

  it('shows the failure summary and attempt count on a failed card [unit]', () => {
    render(
      <BoardCard
        task={boardTask(
          { status: 'failed' },
          { reason: { kind: 'failed', summary: 'step-ca unreachable', attempts: 2 } },
        )}
      />,
    );
    expect(screen.getByTestId('task-card-reason')).toHaveTextContent(
      'step-ca unreachable · 2 attempts',
    );
  });

  it('names the first unmet dependency and counts the rest [unit]', () => {
    render(
      <BoardCard
        task={boardTask(
          {},
          {
            reason: {
              kind: 'waiting_on_dependency',
              dependencies: [
                { id: 'a', title: 'Deploy', trackerId: 'INF-12' },
                { id: 'b', title: 'Certs', trackerId: null },
              ],
            },
          },
        )}
      />,
    );
    expect(screen.getByTestId('task-card-reason')).toHaveTextContent(
      'Waiting on INF-12 · Deploy +1 more',
    );
  });

  it('names the dependency that failed on a dependency_failed card [unit]', () => {
    render(
      <BoardCard
        task={boardTask(
          { status: 'blocked', blockedReason: 'dependency_failed' },
          {
            reason: {
              kind: 'dependency_failed',
              dependency: { id: 'a', title: 'Deploy', trackerId: null },
            },
          },
        )}
      />,
    );
    expect(screen.getByTestId('task-card-reason')).toHaveTextContent('Dependency failed: Deploy');
  });

  it('says a repeating schedule stopped after repeated failures [unit]', () => {
    render(
      <BoardCard task={boardTask({}, { reason: { kind: 'schedule_paused', failures: 3 } })} />,
    );
    expect(screen.getByTestId('task-card-reason')).toHaveTextContent(
      'Schedule paused after 3 failed runs',
    );
  });

  it('marks a task assigned to the user with a "You" chip instead of a reason line [unit]', () => {
    render(
      <BoardCard
        task={boardTask({ assignedTo: 'user' }, { reason: { kind: 'assigned_to_user' } })}
      />,
    );
    expect(screen.getByTestId('task-card-assignee-you')).toBeInTheDocument();
    expect(screen.queryByTestId('task-card-reason')).not.toBeInTheDocument();
  });

  it('shows which plan step a running task is on [unit]', () => {
    render(
      <BoardCard
        task={boardTask({
          status: 'running',
          plan: [
            { step: 'a', done: true },
            { step: 'b', done: false },
            { step: 'c', done: false },
          ],
        })}
      />,
    );
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument();
    expect(screen.getByTestId('task-card-plan')).toHaveTextContent('1/3');
  });

  it("shows a cron task's next run, that it repeats, and how its last run went [unit]", () => {
    render(
      <BoardCard
        task={boardTask({
          status: 'scheduled',
          triggerType: 'cron_repeat',
          schedule: {
            nextFireAt: '2026-10-01T02:00:00.000Z',
            iterationCount: 3,
            active: true,
            inactiveReason: null,
            lastRunOutcome: 'failed',
          },
        })}
      />,
    );
    expect(screen.getByTestId('task-card-schedule')).toHaveTextContent(/next: .*· repeats/);
    expect(screen.getByTestId('task-card-last-run')).toHaveTextContent('last: failed');
  });

  it('shows no schedule line on a task without a schedule [unit]', () => {
    render(<BoardCard task={boardTask()} />);
    expect(screen.queryByTestId('task-card-schedule')).not.toBeInTheDocument();
  });

  it('renders a primary action passed by the caller [unit]', () => {
    render(<BoardCard task={boardTask()} action={<button type="button">Retry</button>} />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
