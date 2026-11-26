import { Fragment, jsx, jsxs } from 'preact/jsx-runtime';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import { Pencil, Trash2 } from 'lucide-preact';
import { SvgSandbox } from '@/components/svg-sandbox';
import { parseSvgSource } from '@/lib/parse-svg-source';
import { Button } from '@/components/ui/button';
import { showToast } from '@/lib/toast';
import { deleteWidget } from '@/services/dashboard-api';
import { WidgetCard, type DragHandleProps } from './widget-card';
import { WidgetHeader } from './widget-header';
import { WidgetContent } from './widget-content';
import { WidgetAction } from './widget-action';
import { WidgetFooter } from './widget-footer';
import { WidgetDrawer } from './widget-drawer';
import { WidgetCopyTargetButton } from './widget-copy-target-button';
import type { SvgWidget as SvgWidgetData } from '@tkottke90/amazing-hashbrown-widgets/types';

interface SvgWidgetProps {
  widget: SvgWidgetData;
  dashboardId: string;
  density: 'compact' | 'roomy';
  onChanged: () => void;
  editMode?: boolean;
  dragHandleProps?: DragHandleProps;
  w?: number;
  h?: number;
  minW?: number;
  minH?: number;
  onResize?: (w: number, h: number) => void;
}

// Renders the SVG Source inside the SVG Sandbox, scaled to fit the card.
// `parseSvgSource` has already sanitized the tree (svgSanitizeSchema), so it
// is safe to render as-is. Anything that isn't exactly one root <svg> gets
// an inline invalid state instead of a blank or broken card; the stored
// body is never touched, so the user can fix it in the drawer.
function SvgSource({ source }: { source: string }) {
  const parsed = parseSvgSource(source);
  if (!parsed.ok) {
    return (
      <p data-testid="svg-widget-invalid" className="text-sm text-muted-foreground">
        Invalid SVG — edit this widget to fix its content.
      </p>
    );
  }
  return (
    <SvgSandbox fit="card">
      {toJsxRuntime(parsed.svg, { Fragment, jsx, jsxs } as Parameters<typeof toJsxRuntime>[1])}
    </SvgSandbox>
  );
}

// Edit/delete controls live here, not in widget-card.tsx — per the design
// doc's D13, the shared card shell stays type-agnostic; the shell is shared with Markdown.
export function SvgWidget({
  widget,
  dashboardId,
  density,
  onChanged,
  editMode,
  dragHandleProps,
  w,
  h,
  minW,
  minH,
  onResize,
}: SvgWidgetProps) {
  async function handleDelete() {
    if (!confirm(`Remove widget "${widget.title}"? This cannot be undone.`)) return;
    try {
      await deleteWidget(dashboardId, widget.id);
      onChanged();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to remove widget');
    }
  }

  return (
    <WidgetCard
      editMode={editMode}
      w={w}
      h={h}
      minW={minW}
      minH={minH}
      density={density}
      onResize={onResize}
    >
      <WidgetHeader
        title={widget.title}
        subtitle={widget.subtitle}
        editMode={editMode}
        dragHandleProps={dragHandleProps}
      />
      <WidgetContent>
        <SvgSource source={widget.content} />
      </WidgetContent>
      <WidgetAction>
        <WidgetDrawer
          mode="edit"
          dashboardId={dashboardId}
          target={{ status: 'ok', widget }}
          onSaved={onChanged}
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-testid="widget-edit-button"
              title="Edit widget"
            >
              <Pencil />
            </Button>
          }
        />
        <WidgetCopyTargetButton
          dashboardId={dashboardId}
          widgetId={widget.id}
          widgetTitle={widget.title}
          widgetType={widget.type}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid="widget-delete-button"
          title="Delete widget"
          onClick={handleDelete}
        >
          <Trash2 />
        </Button>
      </WidgetAction>
      <WidgetFooter
        source={widget.source}
        maintainer={widget.maintainer}
        updatedAt={widget.updatedAt}
      />
    </WidgetCard>
  );
}
