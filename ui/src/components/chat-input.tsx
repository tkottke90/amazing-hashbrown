import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { flushSync } from 'preact/compat';
import { Plus, Send, Square, X, AlertTriangle } from 'lucide-preact';

import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { TextEllipsis } from '@/components/text-ellipsis';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { fetchSkills, type SkillInfo } from '@/services/skills-api';
import {
  uploadArtifact,
  deleteArtifact,
  ACCEPTED_ATTACHMENT_TYPES,
  type UploadedArtifact,
} from '@/services/artifacts-api';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ProviderModelPicker,
  MODEL_SUBMENU_CLOSE_GRACE_MS,
} from '@/components/provider-model-picker';
import type { ProviderInfo } from '@/hooks/use-providers';

export type StagedAttachment = UploadedArtifact;

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
  /**
   * Where a staged file upload/drop is associated — required for the
   * "Add file"/drag-and-drop attachment flow to actually work (the upload
   * endpoint needs a threadId). Omit to leave that flow inert; the rest of
   * ChatInput is unaffected.
   */
  threadId?: string;
  /**
   * Fires whenever the staged attachment changes — on a successful
   * upload, and back to `null` after an explicit remove. The caller
   * (which owns sending the message) reads this to include the
   * attachment id in the send call and to clear it once sent.
   */
  onAttachmentChange?: (attachment: StagedAttachment | null) => void;
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
  threadId,
  onAttachmentChange,
}: ChatInputProps) {
  const canSend = !disabled && !isGenerating && value.trim().length > 0;

  const menuOpen = useSignal(false);
  const menuItems = useSignal<SkillInfo[]>([]);
  const menuIndex = useSignal(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stagedAttachment = useSignal<StagedAttachment | null>(null);
  const attachmentError = useSignal<string | null>(null);
  const dragging = useSignal(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function stageFile(file: File) {
    if (!threadId) return;
    attachmentError.value = null;

    // Only one attachment per message — replace, don't accumulate. Best
    // effort: a failed cleanup of the old one just leaves an orphan for
    // the GC sweep to clean up later, not a reason to block the new upload.
    const previous = stagedAttachment.value;
    if (previous) {
      deleteArtifact(previous.id).catch(() => {});
    }

    try {
      const uploaded = await uploadArtifact(file, threadId);
      stagedAttachment.value = uploaded;
      onAttachmentChange?.(uploaded);
    } catch (err) {
      stagedAttachment.value = null;
      // Only notify the parent when the visible attachment actually
      // changes — a failed first upload (no previous attachment) leaves
      // the parent's state at null already, so there's nothing to report.
      if (previous) onAttachmentChange?.(null);
      attachmentError.value = err instanceof Error ? err.message : 'Upload failed';
    }
  }

  function handleFileInputChange(event: JSX.TargetedEvent<HTMLInputElement>) {
    const file = (event.target as HTMLInputElement).files?.[0];
    // Reset so selecting the same file again still fires onChange.
    (event.target as HTMLInputElement).value = '';
    if (file) void stageFile(file);
  }

  function handleRemoveAttachment() {
    const current = stagedAttachment.value;
    stagedAttachment.value = null;
    attachmentError.value = null;
    onAttachmentChange?.(null);
    if (current) {
      // Removed before send — delete server-side too. Best effort: clear
      // local state either way, per the design's error-handling section;
      // a failed delete just leaves an orphan for the GC sweep.
      deleteArtifact(current.id).catch(() => {});
    }
  }

  function handleDragOver(event: JSX.TargetedDragEvent<HTMLDivElement>) {
    if (!threadId) return;
    event.preventDefault();
    dragging.value = true;
  }

  function handleDragLeave() {
    dragging.value = false;
  }

  function handleDrop(event: JSX.TargetedDragEvent<HTMLDivElement>) {
    if (!threadId) return;
    event.preventDefault();
    dragging.value = false;
    const file = event.dataTransfer?.files[0];
    if (file) void stageFile(file);
  }

  const activeModelImageInput =
    providers
      ?.find((p) => p.name === activeProvider)
      ?.models.find((m) => m.id === activeModel)?.imageInput ?? false;
  const showVisionWarning = !!stagedAttachment.value?.requiresVision && !activeModelImageInput;

  // App-controlled open state for the "Provider" sub-menu, mirroring
  // ProviderModelPicker's own per-provider Subs (see the comment there and
  // docs/superpowers/specs/2026-08-31-model-picker-submenu-fix-design.md).
  // This one also needs to be controlled: with only the inner per-provider
  // Sub controlled, opening it via a genuine keyboard ArrowRight collapsed
  // the entire menu tree back to the root and threw focus out to <body> —
  // Radix's own synchronous "move focus into the newly-opened content" code
  // runs immediately after onOpenChange, and when that inner content's own
  // controlled-Sub render hadn't landed yet relative to *this* Sub's own
  // uncontrolled bookkeeping, this outer Sub's tracking got corrupted and it
  // tore the whole thing down. Controlling this level too, with the same
  // flushSync-forced synchronous open, keeps both levels' state consistent
  // with what Radix expects at every step.
  const providerMenuOpen = useSignal(false);
  const providerCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether some provider's own model list (a separately-portaled subtree —
  // see handleProviderModelMenuOpenChange below) is currently open. While
  // true, this Sub's own close must never actually schedule: the cursor
  // leaving THIS Sub's own trigger/content fires repeatedly as it moves
  // around inside that already-open child (every one of those direct
  // pointer-leave events calls scheduleProviderMenuClose again), and only
  // one of those calls happening to route through the child-open callback
  // isn't enough to guard against the rest.
  const childMenuOpen = useSignal(false);

  function cancelProviderMenuClose() {
    if (providerCloseTimerRef.current !== null) {
      clearTimeout(providerCloseTimerRef.current);
      providerCloseTimerRef.current = null;
    }
  }

  function openProviderMenuNow() {
    cancelProviderMenuClose();
    flushSync(() => {
      providerMenuOpen.value = true;
    });
  }

  function scheduleProviderMenuClose() {
    if (childMenuOpen.peek()) return;
    cancelProviderMenuClose();
    providerCloseTimerRef.current = setTimeout(() => {
      providerCloseTimerRef.current = null;
      providerMenuOpen.value = false;
    }, MODEL_SUBMENU_CLOSE_GRACE_MS);
  }

  function keepProviderMenuOpenOnFocus() {
    if (providerMenuOpen.peek()) {
      cancelProviderMenuClose();
    }
  }

  // A provider's own model list (rendered by ProviderModelPicker) is a
  // separately-portaled DOM subtree — not a DOM descendant of this "Provider"
  // Sub's own trigger/content. So the moment the user's cursor moves off
  // this Sub's own elements and into a provider's model list, THIS Sub's
  // onPointerLeave fires and its own close timer starts, even though the
  // user is still actively using the menu — the cursor just never comes
  // back to re-enter this Sub's own DOM nodes while browsing the model
  // list. Without this signal, that timer fires on schedule and closes
  // "Provider", tearing down the open model list underneath it. Forcing
  // this Sub open whenever ProviderModelPicker reports any provider's
  // model list open — and re-arming this Sub's own close grace once that
  // reports closed — keeps the levels' liveness in sync with each other
  // instead of each one only knowing about its own direct DOM events.
  function handleProviderModelMenuOpenChange(isOpen: boolean) {
    childMenuOpen.value = isOpen;
    if (isOpen) {
      openProviderMenuNow();
    } else {
      scheduleProviderMenuClose();
    }
  }

  useEffect(() => () => cancelProviderMenuClose(), []);

  function selectSkill(skill: SkillInfo) {
    onValueChange(`${skill.slashCommand} `);
    menuOpen.value = false;
    menuIndex.value = 0;
  }

  function handleValueChange(newValue: string) {
    onValueChange(newValue);

    if (isGenerating || !newValue.startsWith('/')) {
      menuOpen.value = false;
      return;
    }

    const spaceIdx = newValue.indexOf(' ');
    if (spaceIdx !== -1) {
      // Command word complete — user is typing args; close menu
      menuOpen.value = false;
      return;
    }

    const query = newValue.slice(1);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchSkills(query)
        .then((results) => {
          menuItems.value = results;
          menuOpen.value = results.length > 0;
          menuIndex.value = 0;
        })
        .catch(() => {
          menuOpen.value = false;
        });
    }, 150);
  }

  function handleKeyDown(event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen.value) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        menuIndex.value = Math.min(menuIndex.value + 1, menuItems.value.length - 1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        menuIndex.value = Math.max(menuIndex.value - 1, 0);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        menuOpen.value = false;
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        const skill = menuItems.value[menuIndex.value];
        if (skill) selectSkill(skill);
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSend) onSend();
    }
  }

  return (
    <div
      data-slot="chat-input"
      className={cn('relative w-full', className)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_ATTACHMENT_TYPES}
        onChange={handleFileInputChange}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
      />

      {dragging.value && (
        <div
          data-slot="chat-input-drop-overlay"
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[4px] border-2 border-dashed border-primary bg-primary/5 text-xs text-primary"
        >
          Drop to attach
        </div>
      )}

      {menuOpen.value && menuItems.value.length > 0 && (
        <div
          data-slot="chat-input-slash-menu"
          className="absolute bottom-full left-0 z-50 mb-1 w-fit overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          {menuItems.value.map((skill, i) => (
            <div
              key={skill.name}
              className={cn('cursor-pointer px-3 py-2', i === menuIndex.value && 'bg-accent')}
              onMouseDown={(e) => {
                e.preventDefault();
                selectSkill(skill);
              }}
              onMouseEnter={() => {
                menuIndex.value = i;
              }}
            >
              <div className="font-mono text-sm font-semibold">{skill.slashCommand}</div>
              <div className="text-xs text-muted-foreground max-w-[70ch]">{skill.description}</div>
            </div>
          ))}
        </div>
      )}

      <div
        className="grid w-full grid-cols-3 gap-2 overflow-hidden rounded-[4px] border border-border p-2"
        style={{
          gridTemplateAreas: `"header header header" "input input input" "actions actions send"`,
        }}
      >
        {header || stagedAttachment.value || attachmentError.value ? (
          <div
            data-slot="chat-input-header"
            style={{ gridArea: 'header' }}
            className="flex min-w-0 flex-wrap items-center gap-1 empty:hidden"
          >
            {header}
            {stagedAttachment.value && (
              <ChatInputChip onRemove={handleRemoveAttachment}>
                {stagedAttachment.value.displayFilename}
              </ChatInputChip>
            )}
            {attachmentError.value && (
              <span className="text-xs text-destructive">{attachmentError.value}</span>
            )}
          </div>
        ) : null}

        <div data-slot="chat-input-body" style={{ gridArea: 'input' }} className="min-w-0">
          <Textarea
            value={value}
            onInput={(event) => handleValueChange((event.target as HTMLTextAreaElement).value)}
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
              <DropdownMenuItem
                onSelect={() => {
                  onAddFile?.();
                  fileInputRef.current?.click();
                }}
              >
                Add file
              </DropdownMenuItem>
              {providers && providers.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuSub
                    open={providerMenuOpen.value}
                    onOpenChange={(open) => {
                      if (open) {
                        openProviderMenuNow();
                      } else {
                        scheduleProviderMenuClose();
                      }
                    }}
                  >
                    <DropdownMenuSubTrigger
                      onPointerEnter={openProviderMenuNow}
                      onFocus={keepProviderMenuOpenOnFocus}
                      onPointerLeave={scheduleProviderMenuClose}
                    >
                      Provider
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent
                      onPointerEnter={openProviderMenuNow}
                      onFocus={keepProviderMenuOpenOnFocus}
                      onPointerLeave={scheduleProviderMenuClose}
                    >
                      <ProviderModelPicker
                        providers={providers}
                        activeProvider={activeProvider ?? undefined}
                        activeModel={activeModel ?? undefined}
                        onSelect={(provider, model) => onModelSelect?.(provider, model)}
                        onAnyOpenChange={handleProviderModelMenuOpenChange}
                      />
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {activeModel && (
            <span
              data-slot="model-chip"
              className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              {activeModel}
              {showVisionWarning && (
                <Tooltip>
                  <TooltipTrigger
                    type="button"
                    aria-label={`${activeModel} does not support image input`}
                    className="inline-flex size-4 items-center justify-center rounded-full bg-destructive/10"
                  >
                    <AlertTriangle className="size-3 text-destructive" />
                  </TooltipTrigger>
                  <TooltipContent>
                    {activeModel} doesn&apos;t support image input — this attachment won&apos;t be
                    sent to the model.
                  </TooltipContent>
                </Tooltip>
              )}
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
    </div>
  );
}
