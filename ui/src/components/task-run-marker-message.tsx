import { PlayCircle, CheckCircle2, XCircle, HelpCircle } from 'lucide-preact';
import { useLocation } from 'preact-iso';
import type { TaskRunMarkerThreadMessage } from '../types/thread-message.js';
import { runName, runPath } from '@/lib/task-runs';

interface TaskRunMarkerMessageProps {
  message: TaskRunMarkerThreadMessage;
}

const OUTCOME_LABEL: Record<NonNullable<TaskRunMarkerThreadMessage['outcome']>, string> = {
  done: 'completed',
  failed: 'failed',
  waiting_on_user: 'waiting on you',
  cancelled: 'cancelled',
  blocked: 'paused',
};

function EndIcon({ outcome }: { outcome: TaskRunMarkerThreadMessage['outcome'] }) {
  if (outcome === 'failed' || outcome === 'cancelled') {
    return <XCircle className="size-3.5 shrink-0 text-red-500" />;
  }
  if (outcome === 'waiting_on_user' || outcome === 'blocked') {
    return <HelpCircle className="size-3.5 shrink-0 text-amber-500" />;
  }
  return <CheckCircle2 className="size-3.5 shrink-0 text-green-600" />;
}

export function TaskRunMarkerMessage({ message }: TaskRunMarkerMessageProps) {
  const { path, route } = useLocation();
  // "Run #3" once markers carry their run; older markers keep the generic
  // wording.
  const subject =
    message.runNumber !== undefined
      ? `${runName(message.runNumber, message.triggerSource)} of task`
      : 'Automated task';
  // Offer the run everywhere except inside that run's own view.
  const openRun =
    message.runThreadId && path !== runPath(message.runThreadId) ? message.runThreadId : null;

  return (
    <div
      data-testid="task-run-marker"
      className="flex items-center gap-2 py-1 text-xs text-muted-foreground"
    >
      {message.phase === 'start' ? (
        <PlayCircle className="size-3.5 shrink-0" />
      ) : (
        <EndIcon outcome={message.outcome} />
      )}
      <span>
        {message.phase === 'start' ? (
          <>
            {subject} started:{' '}
            <span className="font-medium text-foreground">{message.taskTitle}</span>
          </>
        ) : (
          <>
            {subject} {message.outcome ? OUTCOME_LABEL[message.outcome] : 'finished'}:{' '}
            <span className="font-medium text-foreground">{message.taskTitle}</span>
          </>
        )}
      </span>
      {openRun && (
        <button
          type="button"
          data-testid="task-run-marker-open"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={() => route(runPath(openRun))}
        >
          Open run
        </button>
      )}
    </div>
  );
}
