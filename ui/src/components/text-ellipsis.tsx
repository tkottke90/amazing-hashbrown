import type { JSX } from 'preact';

import { cn } from '@/lib/utils';

/**
 * Truncates its content to a single line with a trailing ellipsis.
 *
 * `truncate` alone only ellipsizes a block that can actually shrink below
 * its content size. `block` gives it a width to shrink from, and `min-w-0`
 * overrides the default flex/grid item behavior of never shrinking below
 * content size — without it, this silently fails to truncate when used
 * inside a flex or grid container (the common case for chips, list rows,
 * table cells, etc).
 */
export function TextEllipsis({ className, ...props }: JSX.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      data-slot="text-ellipsis"
      className={cn('block min-w-0 truncate', className)}
      {...props}
    />
  );
}
