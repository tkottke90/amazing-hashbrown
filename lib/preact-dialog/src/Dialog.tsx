import { Signal, useSignal } from '@preact/signals';
import { X as XIcon } from 'lucide-preact';
import { cloneElement, ComponentChildren, createContext, type JSX } from 'preact';
import { useContext, useRef } from 'preact/hooks';
import { useHtmlElementListeners } from './eventListeners';

const X = XIcon;

export interface DialogProps {
  className?: string;
  contentClassName?: string;
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
  children,
  trigger,
  disableClose,
  title,
  onCancel,
  onClose,
  onOpen,
}: DialogProps) {
  const modalValue = useSignal<string | undefined>();
  const modalRef = useRef<HTMLDialogElement>(null);

  const triggerRef = useHtmlElementListeners(
    [['click', () => openModal(modalRef.current, onOpen)]],
    [trigger],
  );

  const triggerElement = cloneElement(trigger ?? <button>Open</button>, { ref: triggerRef });

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
        className={`p-6 text-neutral-800 dark:text-neutral-200
        bg-neutral-50/80 dark:bg-neutral-700/80
        rounded border border-neutral-400/50 ${className ?? ''}`}
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
        <div className={contentClassName ?? ''}>
          <div className="flex">
            <h2 className="grow">{title}</h2>
            {!disableClose && (
              <button
                onClick={() => {
                  cancelModal(modalRef.current, onCancel);
                }}
              >
                <X />
              </button>
            )}
          </div>
          <br />
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
