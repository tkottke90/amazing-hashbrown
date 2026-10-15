import { MarkdownWidget } from './markdown-widget';
import type { DashboardWidget } from './types';

function assertNever(x: never): never {
  throw new Error(`Unhandled widget type: ${(x as DashboardWidget).type}`);
}

interface WidgetRendererProps {
  widget: DashboardWidget;
}

export function WidgetRenderer({ widget }: WidgetRendererProps) {
  switch (widget.type) {
    case 'markdown':
      return <MarkdownWidget widget={widget} />;
    default:
      return assertNever(widget);
  }
}
