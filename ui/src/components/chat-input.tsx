import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { flushSync } from 'preact/compat';
import { Plus, Send, Square, X } from 'lucide-preact';

import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { TextEllipsis } from '@/components/text-ellipsis';
import { fetchSkills, type SkillInfo } from '@/services/skills-api';
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

  const menuOpen = useSignal(false);
  const menuItems = useSignal<SkillInfo[]>([]);
  const menuIndex = useSignal(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    <div data-slot="chat-input" className={cn('relative w-full', className)}>
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
        {header ? (
          <div
            data-slot="chat-input-header"
            style={{ gridArea: 'header' }}
            className="flex min-w-0 flex-wrap items-center gap-1 empty:hidden"
          >
            {header}
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
              <DropdownMenuItem onSelect={onAddFile}>Add file</DropdownMenuItem>
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
    </div>
  );
}
