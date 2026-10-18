import { GripVertical } from 'lucide-preact';
import type { DragHandleProps } from './widget-card';

interface WidgetHeaderProps {
  title: string;
  subtitle?: string;
  /** Edit Mode (see GLOSSARY.md) — gates the drag grip. */
  editMode?: boolean;
  /** Spread onto the drag grip only — keeps Reorder and the rest of the card on disjoint hit areas. */
  dragHandleProps?: DragHandleProps;
}

export function WidgetHeader({
  title,
  subtitle,
  editMode = false,
  dragHandleProps,
}: WidgetHeaderProps) {
  return (
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
  );
}
