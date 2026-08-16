import { Dialog, DialogProps } from './Dialog';

// Docked to the bottom edge, full width, and fades its backdrop like Modal.
// Height fits content up to 90% of the viewport, scrolling beyond that.
const BOTTOM_SHEET_CLASSNAME = `
  fixed inset-x-0 bottom-0 top-auto m-0
  block pointer-events-none opacity-0
  w-full max-h-[90vh]
  transition-opacity transition-discrete duration-200 ease-out
  backdrop:backdrop-blur-xs backdrop:transition-all backdrop:transition-discrete backdrop:duration-200 backdrop:ease-out
  backdrop:bg-transparent open:backdrop:bg-neutral-900/50 starting:open:backdrop:bg-transparent
  open:pointer-events-auto open:opacity-100 z-50
`;

// Slide-up entrance/exit + frosted-glass blur for the inner wrapper. See
// the comment in Dialog.tsx for why these must live here and not on the
// <dialog> element itself: it slides in from fully off-screen below.
const BOTTOM_SHEET_CONTENT_CLASSNAME = `backdrop-blur-sm translate-y-full transition-transform transition-discrete duration-200 ease-out [dialog[open]_&]:translate-y-0`;

/**
 * A bottom sheet is primarily a mobile & tablet pattern that slides up from the bottom of
 * the screen.  This makes it friendly to one-handed use and is typically used as an alternative
 * to side-bar navigation or for input forms.
 */
export function BottomSheet({ children, className, ...props }: DialogProps) {
  return (
    <Dialog
      className={`${BOTTOM_SHEET_CLASSNAME} ${className ?? ''}`}
      contentClassName={BOTTOM_SHEET_CONTENT_CLASSNAME}
      {...props}
    >
      {children}
    </Dialog>
  );
}
