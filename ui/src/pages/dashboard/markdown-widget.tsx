import { Markdown } from '@/components/markdown';
import { WidgetCard } from './widget-card';
import type { MarkdownWidget as MarkdownWidgetData } from './types';

interface MarkdownWidgetProps {
  widget: MarkdownWidgetData;
}

export function MarkdownWidget({ widget }: MarkdownWidgetProps) {
  return (
    <WidgetCard title={widget.title} subtitle={widget.subtitle}>
      <Markdown>{widget.content}</Markdown>
    </WidgetCard>
  );
}
