import { type Signal, effect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

export interface DialogProps {
  open: Signal<boolean>;
  title?: string;
  children: ComponentChildren;
  class?: string;
}

export function Dialog({ open, title, children, class: className }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  // effect() from @preact/signals auto-subscribes to open.value; no dep array needed.
  useEffect(
    () =>
      effect(() => {
        if (open.value) {
          dialogRef.current?.showModal();
        } else {
          dialogRef.current?.close();
        }
      }),
    [],
  );

  // Sync the signal when native cancel fires (Escape key) so parent stays in step.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const onCancel = () => {
      open.value = false;
    };
    el.addEventListener('cancel', onCancel);
    return () => el.removeEventListener('cancel', onCancel);
  }, []);

  // The <dialog> element itself is the backdrop; clicks on the inner panel
  // bubble up but e.target will be the panel div, not the dialog element.
  function handleBackdropClick(e: MouseEvent) {
    if (e.target === dialogRef.current) open.value = false;
  }

  return (
    <dialog
      ref={dialogRef}
      onClick={handleBackdropClick}
      class={`w-full max-w-sm rounded-lg bg-card p-6 shadow-xl [&::backdrop]:bg-black/50 ${className ?? ''}`}
    >
      {title && (
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-sm font-semibold text-foreground">{title}</h2>
          <button
            type="button"
            onClick={() => {
              open.value = false;
            }}
            class="rounded p-0.5 text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      )}
      {children}
    </dialog>
  );
}
