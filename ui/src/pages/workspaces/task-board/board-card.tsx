import { forwardRef } from 'preact/compat';
import type { ComponentChildren, JSX } from 'preact';
import { Bot, Calendar, Clock, Link as LinkIcon } from 'lucide-preact';
import { cn } from '@/lib/utils';
import { formatFireTime } from '@/lib/cron-drafts';
import type { BoardReason, Task, TaskSchedule, TaskStatus } from '@/services/tasks-api';

const STATUS_BADGE: Record<TaskStatus, { label: string; dot: string }> = {
  pending: { label: 'Pending', dot: 'bg-muted-foreground' },
  scheduled: { label: 'Scheduled', dot: 'bg-violet-500' },
  ready: { label: 'Ready', dot: 'bg-amber-500' },
  running: { label: 'Running', dot: 'bg-primary' },
  waiting_on_user: { label: 'Waiting on you', dot: 'bg-amber-500' },
  blocked: { label: 'Blocked', dot: 'bg-destructive' },
  done: { label: 'Done', dot: 'bg-green-600' },
  failed: { label: 'Failed', dot: 'bg-destructive' },
  cancelled: { label: 'Cancelled', dot: 'bg-muted-foreground' },
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const badge = STATUS_BADGE[status];
  return (
    <span
      data-testid="task-card-status"
      class="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium"
    >
      <span class={cn('size-1.5 rounded-full', badge.dot)} />
      {badge.label}
    </span>
  );
}

const LAST_RUN_BADGE: Record<NonNullable<TaskSchedule['lastRunOutcome']>, string> = {
  done: 'bg-green-600/10 text-green-700 dark:text-green-400',
  failed: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
};

// A cron task's card line: when it runs next, whether it repeats, and how its
// last run went.
function ScheduleCardLine({ task, schedule }: { task: Task; schedule: TaskSchedule }) {
  return (
    <p
      data-testid="task-card-schedule"
      class="text-[10px] text-muted-foreground mt-1 flex items-center gap-1 flex-wrap"
    >
      <Clock class="size-3" />
      {schedule.nextFireAt ? `next: ${formatFireTime(schedule.nextFireAt)}` : 'not scheduled'}
      {task.triggerType === 'cron_repeat' && schedule.nextFireAt && <span>· repeats</span>}
      {schedule.lastRunOutcome && (
        <span
          data-testid="task-card-last-run"
          class={cn(
            'rounded-full px-1.5 py-0.5 font-medium',
            LAST_RUN_BADGE[schedule.lastRunOutcome],
          )}
        >
          last: {schedule.lastRunOutcome}
        </span>
      )}
    </p>
  );
}

function refLabel(ref: { title: string; trackerId: string | null }): string {
  return ref.trackerId ? `${ref.trackerId} · ${ref.title}` : ref.title;
}

// The one line that says why the card is where it is.
function ReasonLine({ reason }: { reason: BoardReason }) {
  const base = 'text-[11px] mt-1 leading-snug';
  switch (reason.kind) {
    case 'waiting_on_user':
      return (
        <p data-testid="task-card-reason" class={cn(base, 'text-amber-600 line-clamp-2')}>
          Asks: {reason.question ?? 'waiting for your answer'}
        </p>
      );
    case 'failed':
      return (
        <p data-testid="task-card-reason" class={cn(base, 'text-destructive line-clamp-2')}>
          {reason.summary ? `${reason.summary} · ` : ''}
          {reason.attempts} {reason.attempts === 1 ? 'attempt' : 'attempts'}
        </p>
      );
    case 'paused':
      return (
        <p data-testid="task-card-reason" class={cn(base, 'text-muted-foreground')}>
          Paused
        </p>
      );
    case 'dependency_failed':
      return (
        <p data-testid="task-card-reason" class={cn(base, 'text-destructive truncate')}>
          Dependency failed{reason.dependency ? `: ${refLabel(reason.dependency)}` : ''}
        </p>
      );
    case 'schedule_paused':
      return (
        <p data-testid="task-card-reason" class={cn(base, 'text-destructive')}>
          Schedule paused after {reason.failures} failed {reason.failures === 1 ? 'run' : 'runs'}
        </p>
      );
    case 'waiting_on_dependency': {
      const [first, ...rest] = reason.dependencies;
      return (
        <p data-testid="task-card-reason" class={cn(base, 'text-muted-foreground truncate')}>
          Waiting on {first ? refLabel(first) : 'a dependency'}
          {rest.length > 0 && ` +${rest.length} more`}
        </p>
      );
    }
    case 'assigned_to_user':
      return null; // shown as the "You" assignee chip instead
  }
}

function PlanProgress({ task }: { task: Task }) {
  const steps = task.plan ?? [];
  if (steps.length === 0) return null;
  const done = steps.filter((s) => s.done).length;
  return (
    <span class="flex items-center gap-1.5" data-testid="task-card-plan">
      <span class="h-1 w-8 overflow-hidden rounded-full bg-muted">
        <span
          class={cn('block h-full', done === steps.length ? 'bg-green-600' : 'bg-foreground/70')}
          style={{ width: `${(done / steps.length) * 100}%` }}
        />
      </span>
      {done}/{steps.length}
    </span>
  );
}

// "Step 4 of 6" for a running task: the first unchecked step of its plan.
function currentStep(task: Task): string | null {
  const steps = task.plan ?? [];
  if (task.status !== 'running' || steps.length === 0) return null;
  const index = steps.findIndex((s) => !s.done);
  return `Step ${index === -1 ? steps.length : index + 1} of ${steps.length}`;
}

export type BoardCardProps = {
  task: Task;
  compact?: boolean;
  // A primary action (mobile), rendered in the card's footer.
  action?: ComponentChildren;
  dragging?: boolean;
} & Omit<JSX.HTMLAttributes<HTMLDivElement>, 'action'>;

// A task card on the Kanban board (and, compact, on the mobile list). Pure
// presentation: the caller makes it draggable/clickable by spreading props
// onto its root.
export const BoardCard = forwardRef<HTMLDivElement, BoardCardProps>(function BoardCard(
  { task, compact, action, dragging, class: className, ...rest },
  ref,
) {
  const lane = task.board?.lane;
  const reason = task.board?.reason;
  const step = currentStep(task);

  return (
    <div
      ref={ref}
      data-testid="task-card"
      data-task-id={task.id}
      data-status={task.status}
      {...rest}
      class={cn(
        'bg-card border border-border rounded-[10px] text-left text-sm transition-colors w-full',
        compact ? 'p-3' : 'p-[11px_12px] hover:border-primary/40 cursor-pointer',
        task.status === 'running' && 'border-primary',
        lane === 'done' && 'opacity-70',
        dragging && 'opacity-40',
        className as string | undefined,
      )}
    >
      <div class="flex items-center gap-2 text-[10px] text-muted-foreground">
        <StatusBadge status={task.status} />
        {task.trackerId && (
          <span class="inline-flex items-center gap-0.5 font-mono">
            <LinkIcon class="size-3" />
            {task.trackerId}
          </span>
        )}
        {step && <span class="ml-auto text-primary">{step}</span>}
      </div>

      <p class={cn('font-medium mt-1.5', compact ? 'line-clamp-2' : 'line-clamp-3')}>
        {task.title}
      </p>

      {reason && <ReasonLine reason={reason} />}
      {task.schedule && <ScheduleCardLine task={task} schedule={task.schedule} />}

      <div class="mt-2 flex items-center gap-3 text-[10px] text-muted-foreground">
        <PlanProgress task={task} />
        {task.dueAt && (
          <span class="flex items-center gap-1">
            <Calendar class="size-3" />
            {new Date(task.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </span>
        )}
        <span class="ml-auto flex items-center gap-2">
          {action}
          {task.assignedTo === 'agent' && (
            <span
              aria-label="Assigned to the agent"
              class="inline-flex size-5 items-center justify-center rounded-md bg-primary/10 text-primary"
            >
              <Bot class="size-3" />
            </span>
          )}
          {task.assignedTo === 'user' && (
            <span
              data-testid="task-card-assignee-you"
              class="rounded-full bg-muted px-1.5 py-0.5 font-medium text-foreground"
            >
              You
            </span>
          )}
        </span>
      </div>
    </div>
  );
});
