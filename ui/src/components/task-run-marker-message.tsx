import { PlayCircle, CheckCircle2, XCircle, HelpCircle } from 'lucide-preact';
import type { TaskRunMarkerThreadMessage } from '../types/thread-message.js';

interface TaskRunMarkerMessageProps {
  message: TaskRunMarkerThreadMessage;
}

const OUTCOME_LABEL: Record<NonNullable<TaskRunMarkerThreadMessage['outcome']>, string> = {
  done: 'completed',
  failed: 'failed',
  waiting_on_user: 'waiting on you',
};

function EndIcon({ outcome }: { outcome: TaskRunMarkerThreadMessage['outcome'] }) {
  if (outcome === 'failed') return <XCircle className="size-3.5 shrink-0 text-red-500" />;
  if (outcome === 'waiting_on_user') {
    return <HelpCircle className="size-3.5 shrink-0 text-amber-500" />;
  }
  return <CheckCircle2 className="size-3.5 shrink-0 text-green-600" />;
}

export function TaskRunMarkerMessage({ message }: TaskRunMarkerMessageProps) {
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
            Automated task started:{' '}
            <span className="font-medium text-foreground">{message.taskTitle}</span>
          </>
        ) : (
          <>
            Automated task {message.outcome ? OUTCOME_LABEL[message.outcome] : 'finished'}:{' '}
            <span className="font-medium text-foreground">{message.taskTitle}</span>
          </>
        )}
      </span>
    </div>
  );
}
