import { PlayCircle, CheckCircle2, XCircle } from 'lucide-preact';
import type { SubAgentMarkerThreadMessage } from '../types/thread-message.js';
import { OpenRunLink } from './open-run-link';

interface SubAgentMarkerMessageProps {
  message: SubAgentMarkerThreadMessage;
}

const OUTCOME_LABEL: Record<NonNullable<SubAgentMarkerThreadMessage['outcome']>, string> = {
  done: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  handed_off: 'handed off',
};

function EndIcon({ outcome }: { outcome: SubAgentMarkerThreadMessage['outcome'] }) {
  if (outcome === 'failed' || outcome === 'cancelled') {
    return <XCircle className="size-3.5 shrink-0 text-red-500" />;
  }
  return <CheckCircle2 className="size-3.5 shrink-0 text-green-600" />;
}

export function SubAgentMarkerMessage({ message }: SubAgentMarkerMessageProps) {
  const hasRemainingSiblings =
    message.phase === 'completion' &&
    message.remainingCount !== undefined &&
    message.remainingCount > 0;

  return (
    <div
      data-testid="sub-agent-marker"
      className="flex items-center gap-2 py-1 text-xs text-muted-foreground"
    >
      {message.phase === 'dispatch' ? (
        <PlayCircle className="size-3.5 shrink-0" />
      ) : (
        <EndIcon outcome={message.outcome} />
      )}
      <span>
        {message.phase === 'dispatch' ? (
          <>
            Sub-agent dispatched — role:{' '}
            <span className="font-medium text-foreground">{message.role}</span>
          </>
        ) : (
          <>
            Sub-agent [{message.role}]{' '}
            {message.outcome ? OUTCOME_LABEL[message.outcome] : 'finished'}
          </>
        )}
      </span>
      {hasRemainingSiblings && <span>· {message.remainingCount} sibling(s) still running</span>}
      {message.phase === 'completion' && (
        <OpenRunLink runThreadId={message.runThreadId} testId="sub-agent-marker-open" />
      )}
    </div>
  );
}
