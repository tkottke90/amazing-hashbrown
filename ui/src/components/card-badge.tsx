import type { ComponentChildren } from 'preact';
import { cn } from '@/lib/utils';

// Shared badge/chip styling, extracted from wiki-update-message.tsx. See
// thread-card-shell.tsx's comment — same Composition over Customization
// rationale.
const VARIANT_CLASSES = {
  blue: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  violet: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
  green: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
} as const;

interface CardBadgeProps {
  children: ComponentChildren;
  variant?: keyof typeof VARIANT_CLASSES;
  className?: string;
}

export function CardBadge({ children, variant = 'blue', className }: CardBadgeProps) {
  return (
    <span
      data-slot="card-badge"
      className={cn(
        'rounded-full px-2 py-0.5 text-xs font-medium',
        VARIANT_CLASSES[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
