import { useEffect, useRef } from 'preact/hooks';
import * as d3Selection from 'd3-selection';
import * as d3Shape from 'd3-shape';
import { Pencil, Trash2 } from 'lucide-preact';
import { Button } from '@/components/ui/button';
import { showToast } from '@/lib/toast';
import { deleteWidget, DEFAULT_DASHBOARD_ID } from '@/services/dashboard-api';
import { getDomainColor } from '@/pages/wiki/domain-filter';
import { parseCsvBody } from './parse-csv-body';
import { WidgetCard } from './widget-card';
import { WidgetDrawer } from './widget-drawer';
import type { PieGraphWidget as PieGraphWidgetData } from '@tkottke90/amazing-hashbrown-widgets/types';

interface PieGraphWidgetProps {
  widget: PieGraphWidgetData;
  onChanged: () => void;
}

const CHART_SIZE = 160;
const RADIUS = CHART_SIZE / 2;

export function PieGraphWidget({ widget, onChanged }: PieGraphWidgetProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const { labels, values } = parseCsvBody(widget.data);
    const sel = d3Selection.select(svg);
    sel.selectAll('*').remove();
    if (labels.length === 0) return;

    const pie = d3Shape.pie<number>().sort(null);
    const arc = d3Shape.arc<d3Shape.PieArcDatum<number>>().innerRadius(0).outerRadius(RADIUS);

    const g = sel.append('g').attr('transform', `translate(${RADIUS},${RADIUS})`);

    // Color Override (widget.colors) applies positionally and cycles when
    // shorter than the label count (D10); otherwise falls back to the
    // app-wide categorical palette per label index (D9).
    const overrides = widget.colors;
    g.selectAll('path')
      .data(pie(values))
      .enter()
      .append('path')
      .attr('d', (d) => arc(d) ?? '')
      .attr('fill', (_d, i) =>
        overrides && overrides.length > 0
          ? (overrides[i % overrides.length] ?? getDomainColor(i))
          : getDomainColor(i),
      );
  }, [widget.data, widget.colors]);

  async function handleDelete() {
    if (!confirm(`Remove widget "${widget.title}"? This cannot be undone.`)) return;
    try {
      await deleteWidget(DEFAULT_DASHBOARD_ID, widget.id);
      onChanged();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to remove widget');
    }
  }

  return (
    <WidgetCard
      title={widget.title}
      subtitle={widget.subtitle}
      source={widget.source}
      maintainer={widget.maintainer}
      updatedAt={widget.updatedAt}
    >
      <div data-testid="pie-graph-widget" className="flex justify-center">
        <svg ref={svgRef} viewBox={`0 0 ${CHART_SIZE} ${CHART_SIZE}`} className="h-40 w-40" />
      </div>
      <div className="flex justify-end gap-1">
        <WidgetDrawer
          mode="edit"
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
      </div>
    </WidgetCard>
  );
}
