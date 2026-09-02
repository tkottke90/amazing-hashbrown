import * as React from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

// One TooltipProvider mounted near the app root (see app.tsx) — Radix's
// Tooltip.Root reads this context directly with no fallback, so every
// Tooltip.Root needs a Provider ancestor somewhere or it throws.
function TooltipProvider({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" {...props} />;
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  // Which element to portal into — same rationale as
  // DropdownMenuPortalContext/SelectPortalContext (see dropdown-menu.tsx's
  // comment): portaling to document.body renders behind an open native
  // <dialog>, so this portals into one when open instead. Computed inline
  // here, unlike dropdown-menu.tsx's onOpenChange-driven version, because
  // (verified directly) TooltipContent is only ever mounted while actually
  // open — never kept mounted-but-hidden the way DropdownMenuContent's own
  // comment describes — so a value computed in this render body is never
  // stale; it's recalculated exactly when Content is about to appear.
  const portalContainer = document.querySelector<HTMLElement>('dialog[open]') ?? undefined;

  return (
    <TooltipPrimitive.Portal container={portalContainer}>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-w-[280px] rounded-md bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

export { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent };
