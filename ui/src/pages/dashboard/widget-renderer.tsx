import { MarkdownWidget } from './markdown-widget';
import type { DashboardWidget } from './types';

function assertNever(type: never): never {
  throw new Error(`Unhandled widget type: ${type}`);
}

interface WidgetRendererProps {
  widget: DashboardWidget;
}

export function WidgetRenderer({ widget }: WidgetRendererProps) {
  switch (widget.type) {
    case 'markdown':
      return <MarkdownWidget widget={widget} />;
    default:
      return assertNever(widget.type);
  }
}
