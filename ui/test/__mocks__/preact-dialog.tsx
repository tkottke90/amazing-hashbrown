import type { ComponentChildren } from 'preact';
import type { Signal } from '@preact/signals';
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

const DialogCtx = createContext({ close: () => {} });

function Dialog({
  children,
  trigger,
  open,
}: {
  title?: string | ComponentChildren;
  className?: string;
  contentClassName?: string;
  children: ComponentChildren;
  trigger?: ComponentChildren;
  open?: Signal<boolean>;
}) {
  // Unset `open` => always visible, matching every pre-existing caller
  // (none of which pass `open`) rendering its children unconditionally.
  const isOpen = open ? open.value : true;
  return (
    <div>
      {trigger}
      {isOpen ? children : null}
    </div>
  );
}

export { Dialog, Dialog as Modal, Dialog as Drawer, Dialog as BottomSheet };

export function useDialog() {
  return useContext(DialogCtx);
}
