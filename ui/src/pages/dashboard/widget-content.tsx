import type { ComponentChildren } from 'preact';

interface WidgetContentProps {
  children: ComponentChildren;
}

// Owns its own flex-1/min-h-0/overflow-auto — the one region of a widget
// card allowed to scroll, so a widget whose content overflows its card
// (e.g. a long Markdown body) clips and scrolls here instead of pushing
// WidgetHeader/WidgetAction/WidgetFooter outside the card's bounds.
export function WidgetContent({ children }: WidgetContentProps) {
  return (
    <div data-testid="widget-content" className="min-h-0 flex-1 overflow-auto">
      {children}
    </div>
  );
}
