import type { ComponentChildren } from 'preact';
import { AlertTriangle, Copy, GitFork, Save } from 'lucide-preact';

import { cn } from '@/lib/utils';
import { Markdown } from '@/components/markdown';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

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

// Static — unlike ActionButton, there's nothing to click here. It exists
// only to surface the Tooltip explaining why the attachment preview above
// (see AttachmentPreview) has no thumbnail effect on what the model saw:
// the user sent it anyway despite the vision-gate warning in ChatInput, and
// the server excluded it from the turn (see api's stream-handler.ts's
// resolveAttachmentForTurn).
export function ChatMessageAttachmentWarningAction() {
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        aria-label="Attachments Not Processed"
        className="rounded p-1 text-amber-600 opacity-70 transition-opacity hover:opacity-100 dark:text-amber-400"
      >
        <AlertTriangle className="size-4" />
      </TooltipTrigger>
      <TooltipContent>Attachments Not Processed</TooltipContent>
    </Tooltip>
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

export interface ChatMessageAttachment {
  id: string;
  filename: string;
  mimeType: string;
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
  /** Adds an elevated background and shadow to the message body. */
  showBG?: boolean;
  className?: string;
  /**
   * Visual-only in v1 — no click interaction (see the design spec's
   * Message History section). Rendered regardless of whether the server
   * actually sent it to the model; ChatMessageAttachmentWarningAction
   * (rendered by the caller into `actions`) is what signals exclusion.
   */
  attachment?: ChatMessageAttachment;
}

const metaClass = 'flex items-center text-xs text-muted-foreground';

// Colour keyed by extension, not MIME type, since the extension is what's
// visible in the box — distinct colours make skimming a history of mixed
// attachment types easier than one uniform "it's a document" treatment.
const EXTENSION_BOX_CLASSES: Record<string, string> = {
  pdf: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
  docx: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  md: 'bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300',
  txt: 'bg-gray-100 text-gray-700 dark:bg-gray-800/60 dark:text-gray-300',
};
const DEFAULT_EXTENSION_BOX_CLASSES =
  'bg-gray-100 text-gray-700 dark:bg-gray-800/60 dark:text-gray-300';

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

function AttachmentPreview({ attachment }: { attachment: ChatMessageAttachment }) {
  if (attachment.mimeType.startsWith('image/')) {
    return (
      <img
        data-slot="chat-message-attachment"
        src={`/api/v1/artifacts/${attachment.id}`}
        alt={attachment.filename}
        className="mb-2 max-h-48 max-w-full rounded-md border border-border object-contain"
      />
    );
  }

  const ext = extensionOf(attachment.filename);
  return (
    <div
      data-slot="chat-message-attachment"
      title={attachment.filename}
      className={cn(
        'mb-2 flex size-24 flex-col items-center justify-center rounded-md text-xs font-semibold',
        EXTENSION_BOX_CLASSES[ext] ?? DEFAULT_EXTENSION_BOX_CLASSES,
      )}
    >
      {(ext || '?').toUpperCase()}
    </div>
  );
}

export function ChatMessage({
  message,
  sentAt,
  mirrored = false,
  cost,
  duration,
  actions,
  showBG = false,
  className,
  attachment,
}: ChatMessageProps) {
  const gridAreas = mirrored
    ? '"time time time" "msg msg msg" "cost timing actions"'
    : '"time time time" "msg msg msg" "actions timing cost"';

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
        {attachment && <AttachmentPreview attachment={attachment} />}
        <Markdown>{message}</Markdown>
      </div>

      <div
        data-slot="chat-message-cost"
        style={{ gridArea: 'cost' }}
        className={cn(
          metaClass,
          'flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-1.5',
          mirrored ? 'items-start justify-start' : 'items-end justify-end',
        )}
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
        className={cn(metaClass, 'gap-0.5', mirrored ? 'justify-end' : 'justify-start')}
      >
        {actions}
      </div>
    </div>
  );
}
