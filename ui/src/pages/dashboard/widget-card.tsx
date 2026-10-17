import type { ComponentChildren } from 'preact';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/format-relative-time';
import type { DashboardWidget } from '@tkottke90/amazing-hashbrown-widgets/types';

interface WidgetCardProps {
  title: string;
  subtitle?: string;
  children: ComponentChildren;
  className?: string;
  /** Widget Source — see GLOSSARY.md. Omitted entirely for the reserved, inert 'system' value (D12). */
  source?: DashboardWidget['source'];
  /** Widget Maintainer — see GLOSSARY.md. Rendered as a badge sub-label when `source` is 'agent'. */
  maintainer?: string;
  /** Derived from the widget file's mtime (ADR-0006) — rendered as a relative-time footer. */
  updatedAt?: string;
}

function provenanceBadgeLabel(
  source: DashboardWidget['source'] | undefined,
  maintainer: string | undefined,
): string | null {
  switch (source) {
    case 'manual':
      return 'Manual';
    case 'agent':
      return maintainer ? `Agent · ${maintainer}` : 'Agent';
    case 'system':
      // Reserved, no UI treatment yet (D12) — the actual feature is #320.
      return null;
    default:
      return null;
  }
}

export function WidgetCard({
  title,
  subtitle,
  children,
  className,
  source,
  maintainer,
  updatedAt,
}: WidgetCardProps) {
  const badgeLabel = provenanceBadgeLabel(source, maintainer);
  return (
    <div
      data-testid="widget-card"
      className={cn('flex flex-col gap-2 rounded-md border border-border bg-card p-4', className)}
    >
      <div>
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {children}
      {(badgeLabel || updatedAt) && (
        <div
          data-testid="widget-card-provenance"
          className="flex items-center justify-between text-xs text-muted-foreground"
        >
          {badgeLabel && <span data-testid="widget-card-badge">{badgeLabel}</span>}
          {updatedAt && (
            <span data-testid="widget-card-updated-at">{formatRelativeTime(updatedAt)}</span>
          )}
        </div>
      )}
    </div>
  );
}
