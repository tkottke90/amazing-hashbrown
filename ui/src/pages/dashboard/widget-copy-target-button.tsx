import { useSignal } from '@preact/signals';
import { Check, Copy } from 'lucide-preact';
import { Button } from '@/components/ui/button';
import { getDashboards } from '@/hooks/use-dashboards';

interface WidgetCopyTargetButtonProps {
  dashboardId: string;
  widgetId: string;
  widgetTitle: string;
  widgetType: string;
}

// Builds a Dashboard Widget Target Snippet (GLOSSARY.md) — the only channel
// an agent/CLI has for learning a non-default Dashboard/Widget id, since no
// list_dashboards/list_widgets tool exists (ADR-0019). Omitted from
// system-widget.tsx/spacer-widget.tsx: neither has a Widget Payload an
// agent/CLI write could ever touch.
export function WidgetCopyTargetButton({
  dashboardId,
  widgetId,
  widgetTitle,
  widgetType,
}: WidgetCopyTargetButtonProps) {
  const copied = useSignal(false);

  async function handleCopy() {
    const dashboardName = getDashboards().find((d) => d.id === dashboardId)?.name ?? dashboardId;
    const snippet =
      `Update the widget titled "${widgetTitle}" (id "${widgetId}", type "${widgetType}") ` +
      `on the dashboard "${dashboardName}" (id "${dashboardId}").`;
    await navigator.clipboard.writeText(snippet);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1500);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      data-testid="widget-copy-target-button"
      title="Copy dashboard/widget target for an agent"
      onClick={() => void handleCopy()}
    >
      {copied.value ? <Check /> : <Copy />}
    </Button>
  );
}
