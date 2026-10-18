import type { ComponentChildren } from 'preact';

interface WidgetActionProps {
  children: ComponentChildren;
}

export function WidgetAction({ children }: WidgetActionProps) {
  return (
    <div data-testid="widget-action" className="flex justify-end gap-1">
      {children}
    </div>
  );
}
