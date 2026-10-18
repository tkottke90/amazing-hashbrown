import { formatRelativeTime } from '@/lib/format-relative-time';
import type { DashboardWidget } from '@tkottke90/amazing-hashbrown-widgets/types';

interface WidgetFooterProps {
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

export function WidgetFooter({ source, maintainer, updatedAt }: WidgetFooterProps) {
  const badgeLabel = provenanceBadgeLabel(source, maintainer);
  if (!badgeLabel && !updatedAt) return null;

  return (
    <div
      data-testid="widget-card-provenance"
      className="flex items-center justify-between text-xs text-muted-foreground"
    >
      {badgeLabel && <span data-testid="widget-card-badge">{badgeLabel}</span>}
      {updatedAt && (
        <span data-testid="widget-card-updated-at">{formatRelativeTime(updatedAt)}</span>
      )}
    </div>
  );
}
