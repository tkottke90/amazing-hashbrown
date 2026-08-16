import type { ComponentChildren } from 'preact';
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

const DialogCtx = createContext({ close: () => {} });

function Dialog({
  children,
  trigger,
}: {
  title?: string;
  className?: string;
  contentClassName?: string;
  children: ComponentChildren;
  trigger: ComponentChildren;
}) {
  return (
    <div>
      {trigger}
      {children}
    </div>
  );
}

export { Dialog, Dialog as Modal, Dialog as Drawer, Dialog as BottomSheet };

export function useDialog() {
  return useContext(DialogCtx);
}
