import type { ComponentChildren, JSX } from 'preact';
import type { Signal } from '@preact/signals';
import { cloneElement, createContext, isValidElement } from 'preact';
import { useContext } from 'preact/hooks';

const DialogCtx = createContext({ close: () => {} });

function Dialog({
  children,
  trigger,
  open,
  onOpen,
}: {
  title?: string | ComponentChildren;
  className?: string;
  contentClassName?: string;
  children: ComponentChildren;
  trigger?: JSX.Element;
  open?: Signal<boolean>;
  onOpen?: () => void;
}) {
  // Unset `open` => always visible, matching every pre-existing caller
  // (none of which pass `open`) rendering its children unconditionally.
  const isOpen = open ? open.value : true;
  // Mirrors the real Dialog's openModal(): clicking the trigger fires
  // onOpen synchronously — needed by callers (mcp-server-drawer.tsx,
  // provider-modal.tsx) that reset/refetch transient state on reopen.
  const triggerElement =
    trigger && isValidElement(trigger)
      ? cloneElement(trigger, {
          onClick: (e: Event) => {
            onOpen?.();
            (trigger.props as { onClick?: (e: Event) => void }).onClick?.(e);
          },
        })
      : trigger;
  return (
    <div>
      {triggerElement}
      {isOpen ? children : null}
    </div>
  );
}

export { Dialog, Dialog as Modal, Dialog as Drawer, Dialog as BottomSheet };

export function useDialog() {
  return useContext(DialogCtx);
}
