import type { ComponentChildren } from 'preact';
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

const DialogCtx = createContext({ close: () => {} });

export function Dialog({
  children,
  trigger,
}: {
  title?: string;
  className?: string;
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

export function useDialog() {
  return useContext(DialogCtx);
}
