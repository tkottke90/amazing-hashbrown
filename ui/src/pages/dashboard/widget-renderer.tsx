import type { DashboardWidget, WidgetLoadResult } from '@tkottke90/amazing-hashbrown-widgets/types';
import { BigNumberWidget } from './big-number-widget';
import { LineGraphWidget } from './line-graph-widget';
import { MarkdownWidget } from './markdown-widget';
import { PieGraphWidget } from './pie-graph-widget';
import { WidgetErrorCard } from './widget-error-card';

function assertNever(widget: never): never {
  throw new Error(`Unhandled widget type: ${(widget as { type: string }).type}`);
}

function renderWidget(widget: DashboardWidget, onChanged: () => void) {
  switch (widget.type) {
    case 'markdown':
      return <MarkdownWidget widget={widget} onChanged={onChanged} />;
    case 'big-number':
      return <BigNumberWidget widget={widget} onChanged={onChanged} />;
    case 'line-graph':
      return <LineGraphWidget widget={widget} onChanged={onChanged} />;
    case 'pie-graph':
      return <PieGraphWidget widget={widget} onChanged={onChanged} />;
    default:
      // A true 4-member discriminated union narrows `widget` itself to
      // `never` here (unlike Slice 1's 1-member union, where only the
      // plain string literal `widget.type` narrowed) — pass the object,
      // not `.type`, since property access on `never` is itself an error.
      return assertNever(widget);
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
