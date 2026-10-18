import type { DashboardWidget, WidgetLoadResult } from '@tkottke90/amazing-hashbrown-widgets/types';
import { WIDGET_SIZE_MIN } from '@tkottke90/amazing-hashbrown-widgets/types';
import { showToast } from '@/lib/toast';
import { resizeWidget, DEFAULT_DASHBOARD_ID } from '@/services/dashboard-api';
import { patchDashboardWidget } from '@/hooks/use-dashboard-widgets';
import { BigNumberWidget } from './big-number-widget';
import { LineGraphWidget } from './line-graph-widget';
import { MarkdownWidget } from './markdown-widget';
import { PieGraphWidget } from './pie-graph-widget';
import { SpacerWidget } from './spacer-widget';
import { WidgetErrorCard } from './widget-error-card';
import type { DragHandleProps } from './widget-card';

function assertNever(widget: never): never {
  throw new Error(`Unhandled widget type: ${(widget as { type: string }).type}`);
}

interface RenderWidgetOptions {
  onChanged: () => void;
  editMode: boolean;
  dragHandleProps?: DragHandleProps;
  onResize: (w: number, h: number) => void;
}

function renderWidget(widget: DashboardWidget, options: RenderWidgetOptions) {
  // The WIDGET_SIZE_MIN lookup stays inside each case, narrowed on
  // `widget.type` — doing it once up front, before the switch, would throw
  // on a genuinely unhandled type before ever reaching `assertNever` below.
  const { w, h } = widget;
  const shared = {
    editMode: options.editMode,
    dragHandleProps: options.dragHandleProps,
    onResize: options.onResize,
  };
  switch (widget.type) {
    case 'markdown':
      return (
        <MarkdownWidget
          widget={widget}
          onChanged={options.onChanged}
          w={w}
          h={h}
          minW={WIDGET_SIZE_MIN.markdown.w}
          minH={WIDGET_SIZE_MIN.markdown.h}
          {...shared}
        />
      );
    case 'big-number':
      return (
        <BigNumberWidget
          widget={widget}
          onChanged={options.onChanged}
          w={w}
          h={h}
          minW={WIDGET_SIZE_MIN['big-number'].w}
          minH={WIDGET_SIZE_MIN['big-number'].h}
          {...shared}
        />
      );
    case 'line-graph':
      return (
        <LineGraphWidget
          widget={widget}
          onChanged={options.onChanged}
          w={w}
          h={h}
          minW={WIDGET_SIZE_MIN['line-graph'].w}
          minH={WIDGET_SIZE_MIN['line-graph'].h}
          {...shared}
        />
      );
    case 'pie-graph':
      return (
        <PieGraphWidget
          widget={widget}
          onChanged={options.onChanged}
          w={w}
          h={h}
          minW={WIDGET_SIZE_MIN['pie-graph'].w}
          minH={WIDGET_SIZE_MIN['pie-graph'].h}
          {...shared}
        />
      );
    case 'spacer':
      return (
        <SpacerWidget
          widget={widget}
          onChanged={options.onChanged}
          w={w}
          h={h}
          minW={WIDGET_SIZE_MIN.spacer.w}
          minH={WIDGET_SIZE_MIN.spacer.h}
          {...shared}
        />
      );
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
  editMode?: boolean;
  dragHandleProps?: DragHandleProps;
}

export function WidgetRenderer({
  result,
  onChanged,
  editMode = false,
  dragHandleProps,
}: WidgetRendererProps) {
  if (result.status === 'error') {
    return <WidgetErrorCard result={result} onChanged={onChanged} />;
  }

  async function onResize(w: number, h: number) {
    if (result.status !== 'ok') return;
    try {
      const updated = await resizeWidget(DEFAULT_DASHBOARD_ID, result.widget, w, h);
      patchDashboardWidget(DEFAULT_DASHBOARD_ID, updated);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to resize widget');
    }
  }

  return renderWidget(result.widget, { onChanged, editMode, dragHandleProps, onResize });
}
