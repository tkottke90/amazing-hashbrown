import { Dialog, DialogProps } from './Dialog';

// Positioning, sizing, stacking, and the dialog/backdrop fade transition.
const MODAL_CLASSNAME = `
  absolute block pointer-events-none opacity-0 mx-auto my-4 min-w-10/12
  transition-opacity transition-discrete duration-200
  sm:min-w-150
  backdrop:backdrop-blur-xs backdrop:transition-all backdrop:transition-discrete backdrop:duration-200
  backdrop:bg-transparent open:backdrop:bg-neutral-900/50 starting:open:backdrop:bg-transparent
  open:pointer-events-auto open:opacity-100 z-50
`;

// Slide-in entrance animation + frosted-glass blur for the inner wrapper.
// See the comment in Dialog.tsx for why these must live here and not on
// the <dialog> element itself.
const MODAL_CONTENT_CLASSNAME = `backdrop-blur-sm translate-y-1 transition-transform transition-discrete duration-200 [dialog[open]_&]:translate-y-0`;

/**
 * Standard modal dialog to draw the user's attention to a specific task and capture
 * their focus in the browser.
 */
export function Modal({ children, className, ...props }: DialogProps) {
  return (
    <Dialog
      className={`${MODAL_CLASSNAME} ${className ?? ''}`}
      contentClassName={MODAL_CONTENT_CLASSNAME}
      {...props}
    >
      {children}
    </Dialog>
  );
}