import type { ComponentChildren } from 'preact';
import { cn } from '@/lib/utils';

// Shared bordered-card layout, extracted from iframe-message.tsx. Per
// AGENTS.md § Composition over Customization: this is the presentational
// piece any card-shaped chat message (resource cards today, potentially
// others later) composes, rather than a generic message kind + data bag.
interface ThreadCardShellProps {
  children: ComponentChildren;
  className?: string;
}

export function ThreadCardShell({ children, className }: ThreadCardShellProps) {
  return (
    <div
      data-slot="thread-card-shell"
      className={cn('rounded-md border border-border bg-card max-w-[min(80%,75ch)]', className)}
    >
      {children}
    </div>
  );
}
