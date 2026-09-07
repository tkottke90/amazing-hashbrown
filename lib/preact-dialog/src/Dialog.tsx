import { Signal, useSignal } from '@preact/signals';
import { X as XIcon } from 'lucide-preact';
import { cloneElement, ComponentChildren, createContext, type JSX } from 'preact';
import { useContext, useEffect, useRef } from 'preact/hooks';
import { cn } from './cn';
import { registerEvent, useHtmlElementListeners } from './eventListeners';

const X = XIcon;

export interface DialogProps {
  className?: string;
  contentClassName?: string;
  /** Applied to the title-bar row. Callers that override dialog padding to zero
   *  (e.g. Drawer with !p-0) use this to re-add padding to just the header. */
  headerClassName?: string;
  children: ComponentChildren;
  title?: string | JSX.Element;
  trigger?: JSX.Element;
  disableClose?: boolean;
  open?: Signal<boolean>;
  onClose?: () => void;
  onCancel?: () => void;
  onOpen?: () => void;
}

interface iDialogContext {
  dialog: HTMLDialogElement | null;
  close: (value?: string) => void;
  value: string | undefined;
}

const DialogContext = createContext<iDialogContext>({} as never);

export function useDialog() {
  return useContext(DialogContext);
}

export function Dialog({
  className,
  contentClassName,
  headerClassName,
  children,
  trigger,
  disableClose,
  title,
  open,
  onCancel,
  onClose,
  onOpen,
}: DialogProps) {
  const modalValue = useSignal<string | undefined>();
  const modalRef = useRef<HTMLDialogElement>(null);

  // Controlled-open sync: a caller driving `open` (e.g. a dialog with no
  // visible trigger of its own, opened as a side effect of something else
  // entirely) gets it imperatively applied to the native <dialog> here.
  // Reading `open?.value` in the render body is what subscribes this
  // component to the signal — the same implicit-subscription mechanism
  // `modalValue.value` above already relies on. Guarded on `dialogEl.open`
  // so this never calls `showModal()`/`close()` redundantly (calling
  // `showModal()` on an already-open dialog throws).
  const openValue = open?.value;
  useEffect(() => {
    if (open === undefined) return;
    const dialogEl = modalRef.current;
    if (!dialogEl) return;
    if (openValue && !dialogEl.open) {
      dialogEl.showModal();
    } else if (!openValue && dialogEl.open) {
      dialogEl.close();
    }
  }, [open, openValue]);

  // Native 'close' -> sync back to `open.value`. Fires on Escape, on this
  // component's own X-button path (cancelModal -> closeModal -> .close()),
  // and on useDialog().close() — none of which otherwise notify a caller
  // driving `open`. The guard against a redundant same-value write also
  // prevents this from ever looping with the effect above.
  useEffect(() => {
    const dialogEl = modalRef.current;
    if (!dialogEl || !open) return;
    return registerEvent(dialogEl, 'close', () => {
      if (open.value !== false) {
        open.value = false;
      }
    });
  }, [open]);

  const triggerRef = useHtmlElementListeners(
    [['click', () => openModal(modalRef.current, onOpen)]],
    [trigger],
  );

  // A caller driving the dialog entirely via `open` has no visible trigger
  // of its own — only fall back to the default "Open" button when the
  // caller hasn't opted into controlled mode at all.
  const triggerElement = trigger
    ? cloneElement(trigger, { ref: triggerRef })
    : open
      ? null
      : cloneElement(<button>Open</button>, { ref: triggerRef });

  return (
    <DialogContext.Provider
      value={{
        dialog: modalRef.current,
        value: modalValue.value,
        close: (value?: string) => {
          if (onClose) {
            onClose();
          }

          closeModal(modalRef.current, value);
        },
      }}
    >
      {triggerElement}
      <dialog
        ref={modalRef}
        className={cn(
          'p-6 text-neutral-800 dark:text-neutral-200 bg-neutral-50/80 dark:bg-neutral-700/80 rounded border border-neutral-400/50',
          className,
        )}
      >
        {/*
          A caller-provided (e.g. overlay-variant) inner wrapper class is the
          right place for slide/fade transforms AND frosted-glass
          backdrop-blur — never on the <dialog> element itself. `transform`
          (even translateY(0)) and `backdrop-filter` (even at a small blur
          radius) each independently establish a new containing block for
          `position: fixed` descendants — anything inside (e.g. a Radix
          Select's dropdown, computed via getBoundingClientRect and
          positioned with position: fixed) would be positioned relative to
          the dialog's own box instead of the viewport, landing nowhere near
          its trigger. Removing the transform alone wasn't enough; the
          backdrop-blur on the <dialog> itself was doing the same thing.
          If a variant's classes use `dialog[open]_&`, note Tailwind
          converts `_` to a space, so it compiles to `dialog[open] &` —
          "this element, when a `dialog[open]` ancestor exists."
        */}
        <div className={`flex flex-col flex-1 min-h-0 ${contentClassName ?? ''}`}>
          <div className={`flex items-center shrink-0 ${headerClassName ?? ''}`}>
            <h2 className="grow">{title}</h2>
            {!disableClose && (
              <button
                aria-label="Close"
                onClick={() => {
                  cancelModal(modalRef.current, onCancel);
                }}
              >
                <X />
              </button>
            )}
          </div>
          {children}
        </div>
      </dialog>
    </DialogContext.Provider>
  );
}

type ModalRef = HTMLDialogElement | null;

export function openModal(modal: ModalRef, onOpen?: () => void) {
  if (modal) {
    if (onOpen) {
      onOpen();
    }

    modal.showModal();
  }
}

export function closeModal(modal: ModalRef, value?: string) {
  if (modal) {
    modal.close(value);
  }
}

export function cancelModal(modal: ModalRef, onCancel?: () => void) {
  if (onCancel) {
    onCancel();
  }

  closeModal(modal);
}
