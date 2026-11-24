import type { ComponentChildren } from 'preact';
import { cn } from './cn';

export interface DialogSectionProps {
  className?: string;
  children?: ComponentChildren;
}

// Composable body/footer for Drawer and BottomSheet. Both must be direct
// flex children of Dialog's content wrapper (flex flex-col min-h-0) — a
// <form> wrapping them needs className="contents" so it drops out of the
// flex layout instead of becoming a single flex item that grows past the
// panel and takes the footer with it.
//
// flex-auto (flex-basis: auto), not flex-1 (flex-basis: 0%): BottomSheet's
// <dialog> has no definite height (only a max-h cap), and a flex-basis: 0
// child doesn't report its content size back to an ancestor sizing itself
// from content — WebKit collapses the sheet to roughly just its header.
// flex-auto still fills the remaining space in Drawer's definite h-dvh
// panel, and min-h-0 lets it shrink below its content so overflow-y-auto
// can take over once the panel hits its height.
export function DialogBody({ className, children }: DialogSectionProps) {
  return (
    <div
      data-slot="dialog-body"
      className={cn('flex-auto min-h-0 overflow-y-auto px-5 py-4', className)}
    >
      {children}
    </div>
  );
}

// shrink-0 keeps the action row at full height however much the body
// overflows; the body is the only thing that gives up space.
export function DialogFooter({ className, children }: DialogSectionProps) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        'flex shrink-0 items-center justify-end gap-2 border-t border-neutral-400/50 px-5 py-4',
        className,
      )}
    >
      {children}
    </div>
  );
}
