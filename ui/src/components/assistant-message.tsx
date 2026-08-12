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

export function AssistantMessage({ message, className, onRetry, onFork }: AssistantMessageProps) {
  const isStreaming = message.status === 'streaming';
  const hasContent = message.content.length > 0;
  const hasThought = !!message.thoughtContent;
  const canFork = message.status === 'done' && message.seq !== undefined;

  return (
    <div
      data-testid="assistant-message"
      className={cn('flex flex-col gap-2 max-w-[min(80%,75ch)]', className)}
    >
      <span className="text-xs text-muted-foreground">
        {message.sentAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>

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

      {message.status === 'error' && onRetry && (
        <div className="flex items-center gap-0.5">
          <ActionButton label="Retry" onClick={onRetry}>
            <RotateCcw className="size-4" />
          </ActionButton>
        </div>
      )}

      {canFork && onFork && (
        <div className="flex items-center gap-0.5">
          <ChatMessageForkAction onFork={onFork} />
        </div>
      )}

      {!isStreaming && (message.durationMs !== undefined || message.cost) && (
        <span className="text-xs text-muted-foreground/60 flex gap-2">
          {message.durationMs !== undefined && (
            <span>{(message.durationMs / 1000).toFixed(1)}s</span>
          )}
          {message.cost?.tokensPerSecond != null && (
            <span>{message.cost.tokensPerSecond.toFixed(1)} tok/s</span>
          )}
          {message.cost?.dollars != null && (
            <span>${message.cost.dollars.toFixed(4)}</span>
          )}
        </span>
      )}
    </div>
  );
}
