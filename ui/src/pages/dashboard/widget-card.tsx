import type { ComponentChildren } from 'preact';
import { GripVertical } from 'lucide-preact';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/format-relative-time';
import type { DashboardWidget } from '@tkottke90/amazing-hashbrown-widgets/types';
import { useWidgetResize } from './use-widget-resize';

/** dnd-kit's drag attributes/listeners — typed for React DOM, same as every
 * other Preact/compat consumer of them in this app (see the Tasks board's
 * `cardProps` helper). */
export type DragHandleProps = Record<string, unknown>;

interface WidgetCardProps {
  title: string;
  subtitle?: string;
  children: ComponentChildren;
  className?: string;
  /** Widget Source — see GLOSSARY.md. */
  source?: DashboardWidget['source'];
  /** Widget Maintainer — see GLOSSARY.md. Rendered as a badge sub-label when `source` is 'agent'. */
  maintainer?: string;
  /** Derived from the widget file's mtime (ADR-0006) — rendered as a relative-time footer. */
  updatedAt?: string;
  /** Edit Mode (see GLOSSARY.md) — gates the drag grip and resize handle below. */
  editMode?: boolean;
  /** Spread onto the drag grip only — keeps Reorder and the rest of the card on disjoint hit areas. */
  dragHandleProps?: DragHandleProps;
  /** Widget Size (see GLOSSARY.md) — current w/h and this type's minimum, for the resize handle's live clamp. */
  w?: number;
  h?: number;
  minW?: number;
  minH?: number;
  onResize?: (w: number, h: number) => void;
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
      // System widgets never have a maintainer (ADR-0012) — just the badge.
      return 'System';
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
  editMode = false,
  dragHandleProps,
  w,
  h,
  minW,
  minH,
  onResize,
}: WidgetCardProps) {
  const badgeLabel = provenanceBadgeLabel(source, maintainer);
  const resizable = editMode && w !== undefined && h !== undefined && onResize !== undefined;
  const { cardRef, liveSize, onPointerDown } = useWidgetResize({
    w: w ?? 0,
    h: h ?? 0,
    minW: minW ?? 1,
    minH: minH ?? 1,
    onResize: onResize ?? (() => {}),
  });

  return (
    <div
      ref={cardRef}
      data-testid="widget-card"
      className={cn(
        // h-full: a block element already fills its parent's width by
        // default, but never its height — without this, resizing a
        // widget's h grows the grid cell (SortableGridItem's wrapper, the
        // actual grid item) while this card's own rendered box stays at
        // its natural content height inside it.
        'relative flex h-full flex-col gap-2 rounded-md border border-border bg-card p-4',
        editMode && 'border-dashed',
        className,
      )}
    >
      <div className="flex items-start gap-2">
        {editMode && (
          <button
            type="button"
            data-testid="widget-drag-handle"
            aria-label="Drag to reorder"
            className="mt-0.5 cursor-grab touch-none text-muted-foreground hover:text-foreground"
            {...dragHandleProps}
          >
            <GripVertical className="size-4" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium text-foreground">{title}</h2>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
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
      {resizable && (
        <div
          data-testid="widget-resize-handle"
          role="slider"
          aria-label="Resize widget"
          aria-valuetext={liveSize.value ? `${liveSize.value.w} by ${liveSize.value.h}` : undefined}
          className="absolute bottom-0 right-0 size-4 cursor-se-resize touch-none"
          onPointerDown={onPointerDown}
        >
          <div className="absolute bottom-1 right-1 size-2 rounded-sm border-b-2 border-r-2 border-muted-foreground" />
        </div>
      )}
      {liveSize.value && (
        <span
          data-testid="widget-resize-live-size"
          className="absolute bottom-1 right-6 rounded bg-foreground px-1 text-[10px] text-background"
        >
          {liveSize.value.w}×{liveSize.value.h}
        </span>
      )}
    </div>
  );
}
