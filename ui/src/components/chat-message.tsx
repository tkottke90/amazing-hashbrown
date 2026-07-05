import type { ComponentChildren } from 'preact';
import { Copy, GitFork, Save } from 'lucide-preact';

import { cn } from '@/lib/utils';

function formatTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();

  if (diffMs < 24 * 60 * 60 * 1000) {
    const secs = Math.floor(diffMs / 1000);
    if (secs < 60) return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
  }

  return date.toLocaleString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

interface ActionButtonProps {
  label: string;
  onClick: () => void;
  children: ComponentChildren;
}

function ActionButton({ label, onClick, children }: ActionButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="rounded p-1 text-muted-foreground opacity-50 transition-opacity hover:bg-muted hover:opacity-100"
    >
      {children}
    </button>
  );
}

export function ChatMessageCopyAction({ content }: { content: string }) {
  function handleClick() {
    navigator.clipboard.writeText(content).catch(() => {});
  }
  return (
    <ActionButton label="Copy to clipboard" onClick={handleClick}>
      <Copy className="size-4" />
    </ActionButton>
  );
}

export function ChatMessageForkAction({ onFork }: { onFork?: () => void }) {
  return (
    <ActionButton label="Fork conversation" onClick={onFork ?? (() => {})}>
      <GitFork className="size-4" />
    </ActionButton>
  );
}

export function ChatMessageSaveAction({
  content,
  filename = 'message.md',
}: {
  content: string;
  filename?: string;
}) {
  async function handleClick() {
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'Markdown file', accept: { 'text/markdown': ['.md'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
      } catch {
        // User cancelled
      }
    } else {
      const blob = new Blob([content], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    }
  }
  return (
    <ActionButton label="Save to file" onClick={handleClick}>
      <Save className="size-4" />
    </ActionButton>
  );
}

export interface ChatMessageCost {
  tokensPerSecond?: number;
  dollars?: number;
}

export interface ChatMessageProps {
  message: string;
  sentAt: Date;
  /** Flips time alignment to right and reverses the bottom row order. */
  mirrored?: boolean;
  cost?: ChatMessageCost;
  /** Duration in milliseconds for automated messages. Omit for user messages (renders a spacer). */
  duration?: number;
  actions?: ComponentChildren;
  className?: string;
}

const metaClass = 'flex items-center text-xs text-muted-foreground';

export function ChatMessage({
  message,
  sentAt,
  mirrored = false,
  cost,
  duration,
  actions,
  className,
}: ChatMessageProps) {
  const gridAreas = mirrored
    ? '"time time time" "msg msg msg" "actions timing cost"'
    : '"time time time" "msg msg msg" "cost timing actions"';

  return (
    <div
      data-slot="chat-message"
      data-mirrored={mirrored || undefined}
      className={cn('grid w-full max-w-[80%] grid-cols-3 gap-x-2 gap-y-1', className)}
      style={{ gridTemplateAreas: gridAreas }}
    >
      <div
        data-slot="chat-message-time"
        style={{ gridArea: 'time' }}
        className={cn('text-sm opacity-50', mirrored ? 'text-right' : 'text-left')}
      >
        {formatTime(sentAt)}
      </div>

      <div
        data-slot="chat-message-body"
        style={{ gridArea: 'msg' }}
        className="min-w-0 whitespace-pre-wrap"
      >
        {message}
      </div>

      <div
        data-slot="chat-message-cost"
        style={{ gridArea: 'cost' }}
        className={cn(metaClass, 'gap-1.5', mirrored ? 'justify-end' : 'justify-start')}
      >
        {cost?.tokensPerSecond != null && (
          <span data-slot="chat-message-tps">{cost.tokensPerSecond.toFixed(1)} tok/s</span>
        )}
        {cost?.dollars != null && (
          <span data-slot="chat-message-dollars">${cost.dollars.toFixed(4)}</span>
        )}
      </div>

      <div
        data-slot="chat-message-timing"
        style={{ gridArea: 'timing' }}
        className={cn(metaClass, 'justify-center')}
      >
        {duration != null ? formatDuration(duration) : null}
      </div>

      <div
        data-slot="chat-message-actions"
        style={{ gridArea: 'actions' }}
        className={cn(metaClass, 'gap-0.5', mirrored ? 'justify-start' : 'justify-end')}
      >
        {actions}
      </div>
    </div>
  );
}
