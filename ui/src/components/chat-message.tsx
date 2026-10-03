import type { ComponentChildren } from 'preact';
import { Copy, GitFork, Save } from 'lucide-preact';
import type { UserMessageAttachment } from '@tkottke90/llm-common-types/chat';

import { cn } from '@/lib/utils';
import { Markdown } from '@/components/markdown';
import { AttachmentPreviewModal } from '@/components/attachment-preview-modal';

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

export interface ActionButtonProps {
  label: string;
  onClick: () => void;
  children: ComponentChildren;
}

export function ActionButton({ label, onClick, children }: ActionButtonProps) {
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

export type ChatMessageAttachment = UserMessageAttachment & { previewUrl?: string };

export interface ChatMessageProps {
  message: string;
  sentAt: Date;
  /** Flips time alignment to right and reverses the bottom row order. */
  mirrored?: boolean;
  actions?: ComponentChildren;
  /** Adds an elevated background and shadow to the message body. */
  showBG?: boolean;
  className?: string;
  /**
   * Up to 4 attachments, each rendered as a uniform square tile that opens
   * a preview/download modal on click (see AttachmentPreviewModal). An
   * item's own `included === false` shows a per-tile excluded badge —
   * there's no message-level aggregate warning anymore now that outcomes
   * are independent per attachment.
   */
  attachments?: ChatMessageAttachment[];
}

const metaClass = 'flex items-center text-xs text-muted-foreground';

const gridAreas = '"time time time" "msg msg msg" "actions actions actions"';

export function ChatMessage({
  message,
  sentAt,
  mirrored = false,
  actions,
  showBG = false,
  className,
  attachments,
}: ChatMessageProps) {
  return (
    <div
      data-slot="chat-message"
      data-mirrored={mirrored || undefined}
      className={cn('grid w-full max-w-[min(80%,75ch)] grid-cols-3 gap-x-2 gap-y-1', className)}
      style={{ gridTemplateAreas: gridAreas }}
    >
      <div
        data-slot="chat-message-time"
        style={{ gridArea: 'time' }}
        className="text-sm opacity-50 text-left"
      >
        {formatTime(sentAt)}
      </div>

      <div
        data-slot="chat-message-body"
        style={{ gridArea: 'msg' }}
        className={cn('min-w-0', showBG && 'rounded-lg bg-card px-3 py-4 shadow-md')}
      >
        {attachments && attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((a) => (
              <AttachmentPreviewModal
                key={a.id}
                attachment={a}
                previewUrl={a.previewUrl}
                excluded={a.included === false}
                exclusionReason={a.exclusionReason}
              />
            ))}
          </div>
        )}
        <Markdown>{message}</Markdown>
      </div>

      <div
        data-slot="chat-message-actions"
        style={{ gridArea: 'actions' }}
        className={cn(metaClass, 'gap-0.5', mirrored ? 'justify-end' : 'justify-start')}
      >
        {actions}
      </div>
    </div>
  );
}
