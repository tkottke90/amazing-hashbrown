import { useSignal } from '@preact/signals';
import {
  PlayCircle,
  CheckCircle2,
  XCircle,
  HelpCircle,
  ChevronDown,
  ChevronRight,
} from 'lucide-preact';
import type { TaskRunMarkerThreadMessage } from '../types/thread-message.js';
import { runName } from '@/lib/task-runs';
import { OpenRunLink } from './open-run-link';

interface TaskRunMarkerMessageProps {
  message: TaskRunMarkerThreadMessage;
}

const OUTCOME_LABEL: Record<NonNullable<TaskRunMarkerThreadMessage['outcome']>, string> = {
  done: 'completed',
  failed: 'failed',
  waiting_on_user: 'waiting on you',
  cancelled: 'cancelled',
  blocked: 'paused',
  handed_off: 'handed off',
};

function EndIcon({ outcome }: { outcome: TaskRunMarkerThreadMessage['outcome'] }) {
  if (outcome === 'failed' || outcome === 'cancelled') {
    return <XCircle className="size-3.5 shrink-0 text-red-500" />;
  }
  if (outcome === 'waiting_on_user' || outcome === 'blocked' || outcome === 'handed_off') {
    return <HelpCircle className="size-3.5 shrink-0 text-amber-500" />;
  }
  return <CheckCircle2 className="size-3.5 shrink-0 text-green-600" />;
}

export function TaskRunMarkerMessage({ message }: TaskRunMarkerMessageProps) {
  // "Run #3" once markers carry their run; older markers keep the generic
  // wording.
  const subject =
    message.runNumber !== undefined
      ? `${runName(message.runNumber, message.triggerSource)} of task`
      : 'Automated task';
  const isOpen = useSignal(false);

  return (
    <div
      data-testid="task-run-marker"
      className="flex flex-col gap-1 py-1 text-xs text-muted-foreground"
    >
      <div className="flex items-center gap-2">
        {message.phase === 'start' ? (
          <PlayCircle className="size-3.5 shrink-0" />
        ) : (
          <EndIcon outcome={message.outcome} />
        )}
        {/* min-w-0 is what lets this shrink inside the flex row at all —
            without it, truncate silently does nothing (see TextEllipsis's
            own doc comment). Truncates the whole sentence as a backstop,
            not just the title portion — titles are short by construction
            (Generated Title / TASK_TITLE_MAX_LENGTH) now, so this is
            defense-in-depth for historical rows and the rare async-race
            placeholder, not the primary fix. See
            docs/superpowers/specs/2026-11-08-sub-agent-task-title-design.md. */}
        <span data-testid="task-run-marker-sentence" className="min-w-0 flex-1 truncate">
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
        {message.taskDescription && (
          <button
            type="button"
            data-testid="task-run-marker-toggle"
            onClick={() => {
              isOpen.value = !isOpen.value;
            }}
            aria-label={isOpen.value ? 'Hide full instruction' : 'Show full instruction'}
            className="flex shrink-0 items-center opacity-70 transition-opacity hover:opacity-100"
          >
            {isOpen.value ? (
              <ChevronDown className="size-3 shrink-0" />
            ) : (
              <ChevronRight className="size-3 shrink-0" />
            )}
          </button>
        )}
        <OpenRunLink runThreadId={message.runThreadId} testId="task-run-marker-open" />
      </div>
      {isOpen.value && message.taskDescription && (
        <p data-testid="task-run-marker-description" className="text-xs opacity-80 break-words">
          {message.taskDescription}
        </p>
      )}
    </div>
  );
}
