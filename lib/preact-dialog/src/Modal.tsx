import { Dialog, DialogProps } from './Dialog';

// Positioning, sizing, stacking, and the dialog/backdrop fade transition.
//
// `fixed` + `inset-0` are load-bearing, not decorative: the browser only
// centers a <dialog> via the UA stylesheet's `dialog:modal` rule
// (`position: fixed; inset-block: 0; margin: auto`) while it's promoted to
// the top layer. That promotion — and thus the centering — ends the instant
// close() runs, synchronously, before our opacity transition starts. If we
// left positioning to the UA rule (e.g. via `absolute` with no inset), the
// dialog would keep fading out for the next 200ms, but now positioned
// against whatever CSS-positioned ancestor happens to contain it instead of
// the viewport — a visible snap right as the close animation begins. Setting
// our own `fixed inset-0` unconditionally makes positioning independent of
// top-layer/`:modal` state, so nothing moves when it's dismissed.
const MODAL_CLASSNAME = `
  fixed inset-0 block pointer-events-none opacity-0 mx-auto my-4 min-w-10/12
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
