import type { ComponentChildren } from 'preact';
import { cn } from '@/lib/utils';
import { useWidgetResize } from './use-widget-resize';

/** dnd-kit's drag attributes/listeners — typed for React DOM, same as every
 * other Preact/compat consumer of them in this app (see the Tasks board's
 * `cardProps` helper). */
export type DragHandleProps = Record<string, unknown>;

interface WidgetCardProps {
  children: ComponentChildren;
  className?: string;
  /** Edit Mode (see GLOSSARY.md) — gates the resize handle below. */
  editMode?: boolean;
  /** Widget Size (see GLOSSARY.md) — current w/h and this type's minimum, for the resize handle's live clamp. */
  w?: number;
  h?: number;
  minW?: number;
  minH?: number;
  onResize?: (w: number, h: number) => void;
}

// A bare flex-column shell, shadcn-Card style — composes with WidgetHeader,
// WidgetContent, WidgetAction, WidgetFooter (siblings passed as children) in
// that stacking order. Owns only the resize handle + live-size badge, the
// one piece of chrome that overlays the whole card rather than stacking
// with its content (design spec §3.1).
export function WidgetCard({
  children,
  className,
  editMode = false,
  w,
  h,
  minW,
  minH,
  onResize,
}: WidgetCardProps) {
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
      {children}
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
