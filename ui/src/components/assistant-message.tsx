import { RotateCcw } from 'lucide-preact';
import { Markdown } from './markdown';
import { ThoughtBlock } from './thought-block';
import { ActionButton, ChatMessageForkAction } from './chat-message';
import { cn } from '@/lib/utils';
import type { AssistantThreadMessage } from '../types/thread-message';

interface AssistantMessageProps {
  message: AssistantThreadMessage;
  className?: string;
  onRetry?: () => void;
  onFork?: () => void;
}

function LoadingDots() {
  return (
    <span className="inline-flex gap-1 px-1">
      <span className="animate-bounce size-1.5 rounded-full bg-muted-foreground [animation-delay:0ms]" />
      <span className="animate-bounce size-1.5 rounded-full bg-muted-foreground [animation-delay:150ms]" />
      <span className="animate-bounce size-1.5 rounded-full bg-muted-foreground [animation-delay:300ms]" />
    </span>
  );
}

const gridAreas = '"header header header" "content content content" "metrics spacer actions"';

export function AssistantMessage({ message, className, onRetry, onFork }: AssistantMessageProps) {
  const isStreaming = message.status === 'streaming';
  const hasContent = message.content.length > 0;
  const hasThought = !!message.thoughtContent;
  const canFork = message.status === 'done' && message.seq !== undefined;
  const showRetry = message.status === 'error' && !!onRetry;
  const showFork = canFork && !!onFork;
  const hasMetrics = !isStreaming && (message.durationMs !== undefined || !!message.cost);

  return (
    <div
      data-testid="assistant-message"
      className={cn('grid gap-2 max-w-[min(80%,75ch)]', className)}
      style={{ gridTemplateAreas: gridAreas, gridTemplateColumns: 'auto 1fr auto' }}
    >
      {!message.isContinuation && (
        <span className="text-xs text-muted-foreground" style={{ gridArea: 'header' }}>
          {message.sentAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      )}

      <div className="flex flex-col gap-2 min-w-0" style={{ gridArea: 'content' }}>
        {hasThought && (
          <ThoughtBlock content={message.thoughtContent!} isStreaming={isStreaming && !hasContent} />
        )}

        <div
          className={cn(
            'rounded-lg px-4 py-3 text-sm',
            message.status === 'error' &&
              'border border-destructive/50 bg-destructive/10 text-destructive',
          )}
        >
          {isStreaming && !hasContent ? (
            <LoadingDots />
          ) : message.status === 'error' ? (
            <span>Something went wrong. Please try again.</span>
          ) : (
            <Markdown>{message.content}</Markdown>
          )}
        </div>
      </div>

      {hasMetrics && (
        <span
          className="text-xs text-muted-foreground/60 flex items-center gap-2"
          style={{ gridArea: 'metrics' }}
        >
          {message.durationMs !== undefined && (
            <span>{(message.durationMs / 1000).toFixed(1)}s</span>
          )}
          {message.cost?.tokensPerSecond != null && (
            <span>{message.cost.tokensPerSecond.toFixed(1)} tok/s</span>
          )}
          {message.cost?.dollars != null && <span>${message.cost.dollars.toFixed(4)}</span>}
        </span>
      )}

      {(showRetry || showFork) && (
        <div className="flex items-center justify-end gap-0.5" style={{ gridArea: 'actions' }}>
          {showRetry && (
            <ActionButton label="Retry" onClick={onRetry!}>
              <RotateCcw className="size-4" />
            </ActionButton>
          )}
          {showFork && <ChatMessageForkAction onFork={onFork!} />}
        </div>
      )}
    </div>
  );
}
