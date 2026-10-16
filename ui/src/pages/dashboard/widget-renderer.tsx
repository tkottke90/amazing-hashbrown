import type { DashboardWidget, WidgetLoadResult } from '@tkottke90/amazing-hashbrown-widgets/types';
import { MarkdownWidget } from './markdown-widget';
import { WidgetErrorCard } from './widget-error-card';

function assertNever(type: never): never {
  throw new Error(`Unhandled widget type: ${type}`);
}

function renderWidget(widget: DashboardWidget, onChanged: () => void) {
  switch (widget.type) {
    case 'markdown':
      return <MarkdownWidget widget={widget} onChanged={onChanged} />;
    default:
      return assertNever(widget.type);
  }
}

interface WidgetRendererProps {
  result: WidgetLoadResult;
  onChanged: () => void;
}

export function WidgetRenderer({ result, onChanged }: WidgetRendererProps) {
  if (result.status === 'error') {
    return <WidgetErrorCard result={result} onChanged={onChanged} />;
  }
  return renderWidget(result.widget, onChanged);
}
