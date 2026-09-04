import { useSignal } from '@preact/signals';
import { RotateCcw, ChevronRight, ChevronDown, AlertTriangle } from 'lucide-preact';
import { Markdown } from './markdown';
import { ThoughtBlock } from './thought-block';
import { ActionButton, ChatMessageForkAction } from './chat-message';
import { cn } from '@/lib/utils';
import { showErrorMessages } from '@/hooks/use-thread';
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
  const isError = message.status === 'error';
  const isSuperseded = isError && !!message.superseded;
  // A superseded attempt was already retried — offering to retry it again
  // doesn't make sense, so it never shows the Retry action even expanded.
  const showRetry = isError && !isSuperseded && !!onRetry;
  const showFork = canFork && !!onFork;
  const hasMetrics =
    !isStreaming && (message.durationMs !== undefined || !!message.cost || !!message.usage);

  // Collapsed by default for a superseded row. The repurposed "Show failed
  // attempts" toggle (showErrorMessages) expands every superseded row at
  // once; clicking a single row overrides that default independently of it.
  const expandedOverride = useSignal<boolean | null>(null);
  const expanded = expandedOverride.value ?? showErrorMessages.value;

  if (isSuperseded && !expanded) {
    return (
      <button
        type="button"
        data-testid="assistant-message"
        data-slot="superseded-assistant-message"
        onClick={() => {
          expandedOverride.value = true;
        }}
        className={cn(
          'flex items-center gap-1.5 max-w-[min(80%,75ch)] rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-destructive/10',
          className,
        )}
      >
        <ChevronRight className="size-3.5 shrink-0" />
        Attempt failed — click to view
      </button>
    );
  }

  return (
    <div
      data-testid="assistant-message"
      className={cn('grid gap-2 max-w-[min(80%,75ch)]', className)}
      style={{ gridTemplateAreas: gridAreas, gridTemplateColumns: 'auto 1fr auto' }}
    >
      {!message.isContinuation && (
        <span
          className="flex items-center gap-1 text-xs text-muted-foreground"
          style={{ gridArea: 'header' }}
        >
          {isSuperseded && (
            <button
              type="button"
              title="Collapse"
              onClick={() => {
                expandedOverride.value = false;
              }}
            >
              <ChevronDown className="size-3.5" />
            </button>
          )}
          {message.sentAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      )}

      <div className="flex flex-col gap-2 min-w-0" style={{ gridArea: 'content' }}>
        {hasThought && (
          <ThoughtBlock
            content={message.thoughtContent!}
            isStreaming={isStreaming && !hasContent}
          />
        )}

        <div
          className={cn(
            'rounded-lg px-4 py-3 text-sm',
            isError && 'border border-destructive/50 bg-destructive/10 text-destructive',
          )}
        >
          {isStreaming && !hasContent ? (
            <LoadingDots />
          ) : hasContent ? (
            <>
              <Markdown>{message.content}</Markdown>
              {isError && (
                <div className="mt-2 flex items-center gap-1.5 text-xs opacity-80">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  <span>Response interrupted</span>
                </div>
              )}
            </>
          ) : (
            <span>Something went wrong. Please try again.</span>
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
          {message.usage && (
            <span>
              ({message.usage.inputTokens.toLocaleString()} in /{' '}
              {message.usage.outputTokens.toLocaleString()} out)
            </span>
          )}
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
