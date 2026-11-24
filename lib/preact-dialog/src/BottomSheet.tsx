import { cn } from './cn';
import { Dialog, DialogProps } from './Dialog';

// Docked to the bottom edge, full width, and fades its backdrop like Modal.
// Height fits content up to 90% of the viewport; past that, DialogBody is
// the scroll region (children are expected to be DialogBody/DialogFooter —
// a child that isn't won't scroll).
// flex flex-col makes <dialog> a flex container so Dialog.tsx's inner
// wrapper actually stretches to fill the bounded height below, instead of
// just sizing to its own content and leaving the <dialog>'s native default
// `overflow: auto` to become the (wrong) scroll container — see Drawer.tsx's
// DRAWER_CLASSNAME, which needs this same pattern for the same reason.
// max-w-none overrides the browser's own UA default for a top-layer
// <dialog> (`max-width: calc(100% - 38px)`), which otherwise wins over
// `w-full` and leaves a ~38px gap on the right edge.
// p-0: the panel carries no padding — header, DialogBody, and DialogFooter
// own theirs.
const BOTTOM_SHEET_CLASSNAME = `
  fixed inset-x-0 bottom-0 top-auto m-0 p-0
  flex flex-col overflow-hidden pointer-events-none opacity-0
  w-full max-w-none max-h-[90dvh]
  transition-opacity transition-discrete duration-200 ease-out
  backdrop:backdrop-blur-xs backdrop:transition-all backdrop:transition-discrete backdrop:duration-200 backdrop:ease-out
  backdrop:bg-transparent open:backdrop:bg-neutral-900/50 starting:open:backdrop:bg-transparent
  open:pointer-events-auto open:opacity-100 z-50
`;

// Slide-up entrance/exit + frosted-glass blur for the inner wrapper. See
// the comment in Dialog.tsx for why these must live here and not on the
// <dialog> element itself: it slides in from fully off-screen below.
const BOTTOM_SHEET_CONTENT_CLASSNAME = `
  backdrop-blur-sm
  translate-y-full transition-transform transition-discrete
  duration-200 ease-out [dialog[open]_&]:translate-y-0
`;

/**
 * A bottom sheet is primarily a mobile & tablet pattern that slides up from the bottom of
 * the screen.  This makes it friendly to one-handed use and is typically used as an alternative
 * to side-bar navigation or for input forms.
 */
export function BottomSheet({
  children,
  className,
  contentClassName,
  headerClassName,
  ...props
}: DialogProps) {
  return (
    <Dialog
      className={`${BOTTOM_SHEET_CLASSNAME} ${className ?? ''}`}
      // Merged, not replaced: a caller's contentClassName (e.g. a gap) must
      // not strip the slide/blur classes.
      contentClassName={cn(BOTTOM_SHEET_CONTENT_CLASSNAME, contentClassName)}
      headerClassName={headerClassName ?? 'px-5 pt-4 pb-2'}
      {...props}
    >
      {children}
    </Dialog>
  );
}
