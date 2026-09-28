import { Button } from '@/components/ui/button';
import type { Lane, Task } from '@/services/tasks-api';
import { findMove, LANE_LABELS, requestMove } from './board-move';
import { ReplyForm } from './reply-form';

// The task drawer's Kanban section: what the task needs from you right now
// (answer the agent, retry, unblock, run a scheduled task early) plus a
// "Move to…" picker listing exactly the lanes the server allows — the
// keyboard- and touch-friendly alternative to dragging. Every action is a
// board move, so the drawer and the board can never disagree.
export function BoardCallout({ task }: { task: Task }) {
  const board = task.board;
  if (!board) return null;
  const reason = board.reason;

  const action = (label: string, to: Lane, testId: string, successMessage: string) =>
    findMove(task, to) && (
      <Button
        type="button"
        size="xs"
        variant="outline"
        data-testid={testId}
        onClick={() => requestMove(task, to, { successMessage })}
      >
        {label}
      </Button>
    );

  const destinations = board.moves.filter((m) => m.to !== board.lane);

  return (
    <div
      class="flex flex-col gap-3 rounded-lg border border-border bg-muted/50 p-3"
      data-testid="board-callout"
    >
      {reason?.kind === 'waiting_on_user' && <ReplyForm task={task} reason={reason} />}

      {reason?.kind === 'failed' && (
        <div class="flex items-center gap-2 flex-wrap">
          <p class="text-xs text-destructive flex-1">
            {reason.summary ?? 'The last run failed.'} · {reason.attempts}{' '}
            {reason.attempts === 1 ? 'attempt' : 'attempts'}
          </p>
          {action('Retry', 'queue', 'board-action-retry', `Queued: ${task.title}`)}
        </div>
      )}

      {reason?.kind === 'paused' && (
        <div class="flex items-center gap-2 flex-wrap">
          <p class="text-xs text-muted-foreground flex-1">
            Paused. Unblock it to put it back in the Queue.
          </p>
          {action('Mark unblocked', 'queue', 'board-action-unblock', `Queued: ${task.title}`)}
        </div>
      )}

      {reason?.kind === 'dependency_failed' && (
        <p class="text-xs text-destructive">
          Blocked:{' '}
          {reason.dependency ? `“${reason.dependency.title}” failed` : 'a dependency failed'}. Take
          it over or remove the dependency.
        </p>
      )}

      {reason?.kind === 'schedule_paused' && (
        <div class="flex items-center gap-2 flex-wrap">
          <p class="text-xs text-destructive flex-1">
            Schedule paused after {reason.failures} failed {reason.failures === 1 ? 'run' : 'runs'}.
          </p>
          {action(
            'Resume schedule',
            'scheduled',
            'board-action-resume-schedule',
            `Rescheduled: ${task.title}`,
          )}
        </div>
      )}

      {board.lane === 'scheduled' && (
        <div class="flex items-center gap-2 flex-wrap">
          <p class="text-xs text-muted-foreground flex-1">Joins the Queue at its start time.</p>
          {action('Run now', 'queue', 'board-action-run-now', `Queued: ${task.title}`)}
          {action(
            'Reschedule',
            'scheduled',
            'board-action-reschedule',
            `Rescheduled: ${task.title}`,
          )}
        </div>
      )}

      {destinations.length > 0 && (
        <label class="flex items-center gap-2 text-xs text-muted-foreground">
          Move to
          <select
            data-testid="board-move-to"
            class="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
            value=""
            onChange={(e) => {
              const to = (e.target as HTMLSelectElement).value as Lane;
              (e.target as HTMLSelectElement).value = '';
              if (to) requestMove(task, to, { successMessage: `Moved to ${LANE_LABELS[to]}` });
            }}
          >
            <option value="">Choose a lane…</option>
            {destinations.map((m) => (
              <option key={m.to} value={m.to} disabled={m.needs === 'reply'}>
                {LANE_LABELS[m.to]}
                {m.needs === 'reply' ? ' (answer above)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
