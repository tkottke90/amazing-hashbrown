import { useMemo } from 'preact/hooks';
import { DialogProps, Dialog } from './Dialog';

export interface DrawerProps extends DialogProps {
  /**
   * The side of the screen to slide in from. Defaults to "right".
   */
  side?: 'left' | 'right';
}

// Docked to a viewport edge, full height, and fades its backdrop like Modal.
// Mobile is 90% viewport width; larger screens size to content but cap at 100ch.
// overflow-hidden clips the content wrapper during its slide-in animation so
// that width recalculations (sm:w-fit resolving) don't produce a visible jump.
const DRAWER_CLASSNAME = `
  fixed inset-y-0 m-0 h-dvh max-h-none overflow-hidden
  flex flex-col pointer-events-none opacity-0
  w-[90vw] sm:w-fit sm:max-w-[100ch]
  transition-opacity transition-discrete duration-200 ease-out
  backdrop:backdrop-blur-xs backdrop:transition-all backdrop:transition-discrete backdrop:duration-200 backdrop:ease-out
  backdrop:bg-transparent open:backdrop:bg-neutral-900/50 starting:open:backdrop:bg-transparent
  open:pointer-events-auto open:opacity-100 z-50
  open:translate-x-0
`;

const SIDE_CLASSNAME: Record<'left' | 'right', string> = {
  left: 'left-0 right-auto',
  right: 'right-0 left-auto',
};

// Direction-aware slide entrance/exit + frosted-glass blur for the inner
// wrapper. The <dialog> carries overflow-hidden so the inner div is clipped
// to the panel bounds during the animation — this hides the absolute-pixel
// jump that sm:w-fit causes as the dialog width resolves (translate-x-full
// is percentage-based and changes with width).
const SIDE_CONTENT_CLASSNAME: Record<'left' | 'right', string> = {
  // left: '-translate-x-full',
  // right: 'translate-x-full',

  left: '',
  right: '',
};

/**
 * A modal container which slides in from the side of the screen (left/right). It is
 * the full height of the viewport and is typically used for drilling down into specific
 * details, editing settings, or as a input form.  On mobile devices it has a 90% view
 * width and on larger screens it conforms to the content width but never exceeds 100ch.
 */
export function Drawer({ children, className, side, headerClassName, ...props }: DrawerProps) {
  const configuredSide = useMemo(() => side ?? 'right', [side]);

  return (
    <Dialog
      className={`${DRAWER_CLASSNAME} ${SIDE_CLASSNAME[configuredSide]} ${className ?? ''}`}
      contentClassName={`flex-1 min-h-0 backdrop-blur-sm transition-transform transition-discrete duration-200 ease-out ${SIDE_CONTENT_CLASSNAME[configuredSide]}`}
      headerClassName={headerClassName ?? 'px-5 pt-4 pb-2'}
      {...props}
    >
      {children}
    </Dialog>
  );
}
