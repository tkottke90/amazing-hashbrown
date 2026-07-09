import { Markdown } from './markdown';
import { ThoughtBlock } from './thought-block';
import { cn } from '@/lib/utils';
import type { AssistantThreadMessage } from '../types/thread-message';

interface AssistantMessageProps {
  message: AssistantThreadMessage;
  className?: string;
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

export function AssistantMessage({ message, className }: AssistantMessageProps) {
  const isStreaming = message.status === 'streaming';
  const hasContent = message.content.length > 0;
  const hasThought = !!message.thoughtContent;

  return (
    <div className={cn('flex flex-col gap-2 max-w-[min(80%,75ch)]', className)}>
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

      {!isStreaming && message.durationMs !== undefined && (
        <span className="text-xs text-muted-foreground/60">
          {(message.durationMs / 1000).toFixed(1)}s
        </span>
      )}
    </div>
  );
}
