import { useEffect, useRef } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import {
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
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
}

// How long we wait, after the pointer/focus leaves a provider's trigger or
// its content — or Radix's own internal timing decides to close it — before
// actually closing that provider's model sub-menu. Exported so tests can
// reference the real value instead of duplicating the number.
export const MODEL_SUBMENU_CLOSE_GRACE_MS = 200;

// Provider -> model drill-down, shared by the chat input's model switcher
// and the cost-rates Add-rate modal. Renders one DropdownMenuSub per
// provider (nested inside whatever DropdownMenuContent/DropdownMenuSub the
// caller already has open) containing a DropdownMenuCheckboxItem per model.
// Does not render its own outer "Provider" trigger/wrapper — callers that
// want one (e.g. chat-input.tsx, nesting this under an "Add to message"
// menu) render it themselves around this component.
//
// The per-provider Sub's open state is app-controlled rather than left to
// Radix's own hover/focus timing: when this is nested three levels deep
// (as chat-input.tsx does), Radix's internal grace-area handling for
// nested Sub components closes the sub-menu before the cursor or keyboard
// focus can reach it (issue #113). Radix's own onOpenChange(false) is
// treated as "maybe close" rather than "close now" — it starts the same
// grace-delay timer a real pointer-leave would, so a stray premature close
// signal can still be cancelled by a subsequent re-entry. See
// docs/superpowers/specs/2026-08-31-model-picker-submenu-fix-design.md.
export function ProviderModelPicker({
  providers,
  activeProvider,
  activeModel,
  onSelect,
  isModelHidden,
}: ProviderModelPickerProps) {
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
    cancelPendingClose();
    openProvider.value = name;
  }

  function scheduleProviderClose(name: string) {
    cancelPendingClose();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      if (openProvider.peek() === name) {
        openProvider.value = null;
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

  return (
    <>
      {providers.map((p) => {
        const models = isModelHidden
          ? p.models.filter((m) => !isModelHidden(p.name, m.id))
          : p.models;

        if (isModelHidden && models.length === 0) return null;

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
              onPointerEnter={() => openProviderNow(p.name)}
              onFocus={() => keepOpenOnFocus(p.name)}
              onPointerLeave={() => scheduleProviderClose(p.name)}
            >
              {p.name}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              onPointerEnter={() => openProviderNow(p.name)}
              onFocus={() => keepOpenOnFocus(p.name)}
              onPointerLeave={() => scheduleProviderClose(p.name)}
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
}
