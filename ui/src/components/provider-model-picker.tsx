import { useEffect, useRef } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import { flushSync } from 'preact/compat';
import { CheckIcon } from 'lucide-preact';
import { BottomSheet } from '@tkottke90/preact-dialog';
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { useIsMobileViewport } from '@/hooks/use-is-mobile-viewport';
import type { ProviderInfo } from '@/hooks/use-providers';

export interface ProviderModelPickerProps {
  providers: ProviderInfo[];
  activeProvider?: string;
  activeModel?: string;
  onSelect: (provider: string, model: string) => void;
  /**
   * When provided, models this returns `true` for are hidden from that
   * provider's list. A provider whose every model is hidden this way is
   * itself omitted (nothing left to drill into). Omit entirely to render
   * every provider/model unfiltered.
   */
  isModelHidden?: (provider: string, modelId: string) => boolean;
  /**
   * Fires `true` the moment any provider's model list opens, and `false`
   * once it actually closes (after the grace delay, not on every
   * momentary pointer-leave). A caller nesting this inside its own
   * hover-controlled wrapper Sub (e.g. chat-input.tsx's "Provider" menu)
   * needs this: a provider's model list is a separately-portaled DOM
   * subtree, not a descendant of the wrapper's own trigger/content, so the
   * wrapper's own pointer-leave fires the instant the cursor moves off its
   * elements into the (physically elsewhere) model list — even though the
   * user is still actively using the menu. Without being told "a child is
   * open," the wrapper has no way to know it shouldn't act on that leave.
   * Desktop-only concept — the mobile bottom sheet below isn't a nested
   * Sub, so it never needs to fire this.
   */
  onAnyOpenChange?: (isOpen: boolean) => void;
}

// How long we wait, after the pointer/focus leaves a provider's trigger or
// its content — or Radix's own internal timing decides to close it — before
// actually closing that provider's model sub-menu. Exported so tests can
// reference the real value instead of duplicating the number.
export const MODEL_SUBMENU_CLOSE_GRACE_MS = 200;

// Mirrors Radix's own internal `whenMouse` guard on its pointer-hover
// handlers (MenuItemImpl/MenuSubTrigger/MenuContentImpl in radix-ui's
// menu.tsx) — hover-driven open/close state must never react to touch or
// pen, only real mouse hover. Our own onPointerEnter/onPointerLeave below
// never had this guard, which is the root cause of issue #130: a touch
// tap's synthesized pointerleave was arming the close timer meant only for
// a real pointer moving away.
export function whenMouse<E extends { pointerType: string }>(
  handler: (event: E) => void,
): (event: E) => void {
  return (event) => {
    if (event.pointerType === 'mouse') handler(event);
  };
}

function visibleModels(p: ProviderInfo, isModelHidden?: ProviderModelPickerProps['isModelHidden']) {
  return isModelHidden ? p.models.filter((m) => !isModelHidden(p.name, m.id)) : p.models;
}

// Provider -> model drill-down, shared by the chat input's model switcher
// and the cost-rates Add-rate modal. Returns `items` — one DropdownMenuSub
// (desktop) or DropdownMenuItem (mobile) per provider, meant to render
// inside whatever DropdownMenuContent/DropdownMenuSub the caller already
// has open — and `sheet`, a BottomSheet holding a tapped provider's models
// on mobile.
//
// This is a hook, not a component, because `sheet` must be rendered by the
// caller as a SIBLING of their own <DropdownMenu>, not nested inside it:
// Radix unmounts DropdownMenuContent/SubContent shortly after it closes,
// and selecting a provider on mobile closes the whole menu tree — so a
// BottomSheet rendered as part of `items` (i.e. still inside that closing
// content) would be torn down before a user could ever use it. A portal
// only changes DOM placement, not component lifecycle, so portaling alone
// doesn't fix this — the sheet has to live outside the part of the tree
// that unmounts. See docs referenced in chat-input.tsx/rate-modal.tsx for
// how each caller wires `items`/`sheet` in.
//
// Desktop (>=640px): unchanged from before this hook existed. The
// per-provider Sub's open state is app-controlled rather than left to
// Radix's own hover/focus timing: when this is nested three levels deep
// (as chat-input.tsx does), Radix's internal grace-area handling for
// nested Sub components closes the sub-menu before the cursor or keyboard
// focus can reach it (issue #113). Radix's own onOpenChange(false) is
// treated as "maybe close" rather than "close now" — it starts the same
// grace-delay timer a real pointer-leave would, so a stray premature close
// signal can still be cancelled by a subsequent re-entry. See
// docs/superpowers/specs/2026-08-31-model-picker-submenu-fix-design.md.
//
// Mobile (<640px): a provider's model list no longer nests under it as a
// second flyout — on a narrow viewport, long model names (e.g. GGUF quant
// filenames) made that flyout overflow off-screen. Instead each provider
// is a flat, tappable item; selecting one closes the whole menu (Radix's
// default onSelect behavior) and opens the shared BottomSheet with that
// provider's models. See docs/superpowers/specs/... for the full design.
export function useProviderModelPicker({
  providers,
  activeProvider,
  activeModel,
  onSelect,
  isModelHidden,
  onAnyOpenChange,
}: ProviderModelPickerProps) {
  const isMobile = useIsMobileViewport();

  // --- Desktop-only state, unchanged from before this was a hook ---

  // Which single provider's model list is open. One shared value rather
  // than one boolean per provider, so moving directly from one provider's
  // trigger to a sibling's trigger can never leave two open at once.
  const openProvider = useSignal<string | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancelPendingClose() {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function openProviderNow(name: string) {
    const wasAnyOpen = openProvider.peek() !== null;
    cancelPendingClose();
    // Radix runs synchronous continuation code right after calling
    // onOpenChange(true) — e.g. moving focus onto the first item inside the
    // newly-opened content — but Preact/signals batches the render from a
    // plain signal write until a later microtask. In a real browser (no
    // Testing Library act() forcing a flush, unlike the unit/e2e tests that
    // originally validated this), Radix's own follow-up code runs before
    // that render lands, finds the content not yet in the DOM, and aborts
    // by closing the whole menu tree. flushSync forces the DOM to reflect
    // `openProvider` before this function returns, so Radix's own
    // synchronous logic sees it.
    flushSync(() => {
      openProvider.value = name;
    });
    if (!wasAnyOpen) onAnyOpenChange?.(true);
  }

  function scheduleProviderClose(name: string) {
    cancelPendingClose();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      if (openProvider.peek() === name) {
        openProvider.value = null;
        onAnyOpenChange?.(false);
      }
    }, MODEL_SUBMENU_CLOSE_GRACE_MS);
  }

  // Guards an already-open provider against a pending close when focus
  // moves within its trigger/content (e.g. arrowing between its models) —
  // it does NOT force a provider open. Radix moves real DOM focus onto a
  // trigger merely by roving through sibling items (e.g. opening the outer
  // "Provider" menu focuses its first provider), and forcing an open from
  // that alone would open every provider's models as focus rolls past it,
  // which is both wrong for keyboard users and — since it happens
  // synchronously inside Radix's own focus handling — was observed to
  // destabilize the outer Sub's own open state. Opening still happens via
  // pointer-enter or Radix's own onOpenChange(true) (click/ArrowRight).
  function keepOpenOnFocus(name: string) {
    if (openProvider.peek() === name) {
      cancelPendingClose();
    }
  }

  useEffect(() => () => cancelPendingClose(), []);

  // --- Mobile-only state ---
  const sheetOpen = useSignal(false);
  const sheetProviderName = useSignal<string | null>(null);

  const items = (
    <>
      {providers.map((p) => {
        const models = visibleModels(p, isModelHidden);

        if (isModelHidden && models.length === 0) return null;

        if (isMobile) {
          return (
            <DropdownMenuItem
              key={p.name}
              className={p.name === activeProvider ? 'font-semibold' : undefined}
              onSelect={() => {
                sheetProviderName.value = p.name;
                sheetOpen.value = true;
              }}
            >
              {p.name}
            </DropdownMenuItem>
          );
        }

        return (
          <DropdownMenuSub
            key={p.name}
            open={openProvider.value === p.name}
            onOpenChange={(open) => {
              if (open) {
                openProviderNow(p.name);
              } else {
                scheduleProviderClose(p.name);
              }
            }}
          >
            <DropdownMenuSubTrigger
              className={p.name === activeProvider ? 'font-semibold' : undefined}
              onPointerEnter={whenMouse(() => openProviderNow(p.name))}
              onFocus={() => keepOpenOnFocus(p.name)}
              onPointerLeave={whenMouse(() => scheduleProviderClose(p.name))}
            >
              {p.name}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              onPointerEnter={whenMouse(() => openProviderNow(p.name))}
              onFocus={() => keepOpenOnFocus(p.name)}
              onPointerLeave={whenMouse(() => scheduleProviderClose(p.name))}
            >
              {models.map((m) => (
                <DropdownMenuCheckboxItem
                  key={m.id}
                  checked={m.id === activeModel && p.name === activeProvider}
                  onSelect={() => onSelect(p.name, m.id)}
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
        );
      })}
    </>
  );

  const sheetProvider = providers.find((p) => p.name === sheetProviderName.value);
  const sheetModels = sheetProvider ? visibleModels(sheetProvider, isModelHidden) : [];

  const sheet = (
    <BottomSheet
      open={sheetOpen}
      className="max-h-[80vh] max-w-full overflow-hidden"
      title={sheetProviderName.value ?? undefined}
    >
      <div
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto"
        data-slot="provider-model-picker-sheet-list"
      >
        {sheetModels.map((m) => {
          const isChecked = m.id === activeModel && sheetProviderName.value === activeProvider;
          return (
            <button
              key={m.id}
              type="button"
              data-slot="provider-model-picker-sheet-item"
              className="relative flex min-h-11 w-full cursor-default items-center gap-1.5 rounded-md py-2 pr-8 pl-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                onSelect(sheetProviderName.value as string, m.id);
                sheetOpen.value = false;
              }}
            >
              {m.id}
              {m.inputPricePerM !== undefined && m.outputPricePerM !== undefined && (
                <DropdownMenuLabel className="ml-2 text-xs text-muted-foreground">
                  ${m.inputPricePerM} / 1M in · ${m.outputPricePerM} / 1M out
                </DropdownMenuLabel>
              )}
              <span
                className="pointer-events-none absolute right-2 flex items-center justify-center"
                data-slot="provider-model-picker-sheet-item-indicator"
              >
                {isChecked && <CheckIcon />}
              </span>
            </button>
          );
        })}
      </div>
    </BottomSheet>
  );

  return { items, sheet };
}
