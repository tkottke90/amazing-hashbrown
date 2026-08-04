import type { ComponentChildren, JSX } from 'preact';
import { Plus, Send, Square, X } from 'lucide-preact';

import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { TextEllipsis } from '@/components/text-ellipsis';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ProviderInfo } from '@/hooks/use-providers';

export interface ChatInputProps {
  /**
   * Chips for non-text context additions (files, images, etc.), rendered in
   * the header row. Use `ChatInputChip` for each item so long names truncate
   * instead of overflowing.
   */
  header?: ComponentChildren;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  onSend: () => void;
  onStop?: () => void;
  /** When true, the send button becomes a stop button. */
  isGenerating?: boolean;
  disabled?: boolean;
  /** Extra actions rendered alongside the add-content menu (e.g. model switcher). */
  actions?: ComponentChildren;
  onAddFile?: () => void;
  className?: string;
  providers?: ProviderInfo[];
  activeProvider?: string | null;
  activeModel?: string | null;
  onModelSelect?: (provider: string, model: string) => void;
}

export interface ChatInputChipProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  /** Renders a trailing remove (X) button that calls this when clicked. */
  onRemove?: () => void;
}

export function ChatInputChip({ className, children, onRemove, ...props }: ChatInputChipProps) {
  return (
    <span
      data-slot="chat-input-chip"
      className={cn(
        'inline-flex min-w-0 max-w-[300px] items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground',
        className,
      )}
      {...props}
    >
      <TextEllipsis>{children}</TextEllipsis>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove"
          className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

export function ChatInput({
  header,
  value,
  onValueChange,
  placeholder = 'Message...',
  onSend,
  onStop,
  isGenerating = false,
  disabled = false,
  actions,
  onAddFile,
  className,
  providers,
  activeProvider,
  activeModel,
  onModelSelect,
}: ChatInputProps) {
  const canSend = !disabled && !isGenerating && value.trim().length > 0;

  function handleKeyDown(event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSend) onSend();
    }
  }

  return (
    <div
      data-slot="chat-input"
      className={cn(
        'grid w-full grid-cols-3 gap-2 overflow-hidden rounded-[4px] border border-border p-2',
        className,
      )}
      style={{
        gridTemplateAreas: `"header header header" "input input input" "actions actions send"`,
      }}
    >
      {header ? (
        <div
          data-slot="chat-input-header"
          style={{ gridArea: 'header' }}
          className="flex min-w-0 flex-wrap items-center gap-1 empty:hidden"
        >
          {header}
        </div>
      ) : null}

      <div data-slot="chat-input-body" style={{ gridArea: 'input' }} className="relative min-w-0">
        {/* Stub for a future inline slash-command menu anchored to the caret. */}
        <div data-slot="chat-input-slash-menu" className="hidden" />
        <Textarea
          value={value}
          onInput={(event) => onValueChange((event.target as HTMLTextAreaElement).value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={2}
          className="max-h-40 resize-none overflow-y-auto border-none bg-transparent px-1 py-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
      </div>

      <div
        data-slot="chat-input-actions"
        style={{ gridArea: 'actions' }}
        className="flex min-w-0 items-center gap-1 overflow-x-auto"
      >
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Add to message"
            className={buttonVariants({ variant: 'outline', size: 'icon-sm' })}
          >
            <Plus />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={onAddFile}>Add file</DropdownMenuItem>
            {providers && providers.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Provider</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {providers.map((p) => (
                      <DropdownMenuSub key={p.name}>
                        <DropdownMenuSubTrigger
                          className={p.name === activeProvider ? 'font-semibold' : undefined}
                        >
                          {p.name}
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          {p.models.map((m) => (
                            <DropdownMenuCheckboxItem
                              key={m.id}
                              checked={m.id === activeModel && p.name === activeProvider}
                              onSelect={() => onModelSelect?.(p.name, m.id)}
                            >
                              {m.id}
                              {m.inputPricePerM !== undefined && m.outputPricePerM !== undefined && (
                                <DropdownMenuLabel className="ml-2 text-xs text-muted-foreground">
                                  ${m.inputPricePerM} / 1M in · ${m.outputPricePerM} / 1M out
                                </DropdownMenuLabel>
                              )}
                            </DropdownMenuCheckboxItem>
                          ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {activeModel && (
          <span
            data-slot="model-chip"
            className="inline-flex items-center rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
          >
            {activeModel}
          </span>
        )}
        {actions}
      </div>

      <div
        data-slot="chat-input-send"
        style={{ gridArea: 'send' }}
        className="flex items-center justify-end"
      >
        <Button
          type="button"
          size="icon"
          aria-label={isGenerating ? 'Stop generating' : 'Send message'}
          disabled={isGenerating ? false : !canSend}
          onClick={isGenerating ? onStop : onSend}
        >
          {isGenerating ? <Square /> : <Send />}
        </Button>
      </div>
    </div>
  );
}
