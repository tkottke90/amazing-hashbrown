import { useEffect, useRef } from 'preact/hooks';
import * as d3Scale from 'd3-scale';
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
import type { LineGraphWidget as LineGraphWidgetData } from '@tkottke90/amazing-hashbrown-widgets/types';

interface LineGraphWidgetProps {
  widget: LineGraphWidgetData;
  onChanged: () => void;
}

const CHART_WIDTH = 320;
const CHART_HEIGHT = 160;
const MARGIN = { top: 8, right: 8, bottom: 20, left: 8 };
// At most this many x-axis tick labels, regardless of point count (D11) —
// avoids overlapping, unreadable text on a chart with many data points.
const MAX_TICKS = 5;

export function LineGraphWidget({ widget, onChanged }: LineGraphWidgetProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const { labels, values } = parseCsvBody(widget.data);
    const sel = d3Selection.select(svg);
    sel.selectAll('*').remove();
    if (labels.length === 0) return;

    const innerWidth = CHART_WIDTH - MARGIN.left - MARGIN.right;
    const innerHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;

    const x = d3Scale.scalePoint<string>().domain(labels).range([0, innerWidth]);
    const y = d3Scale
      .scaleLinear()
      .domain([Math.min(0, ...values), Math.max(...values)])
      .range([innerHeight, 0])
      .nice();

    const line = d3Shape
      .line<number>()
      .x((_d, i) => x(labels[i] ?? '') ?? 0)
      .y((d) => y(d));

    const g = sel.append('g').attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

    g.append('path')
      .attr('d', line(values) ?? '')
      .attr('fill', 'none')
      .attr('stroke', widget.color ?? getDomainColor(0))
      .attr('stroke-width', 2);

    const step = Math.max(1, Math.ceil(labels.length / MAX_TICKS));
    const tickLabels = labels.filter((_label, i) => i % step === 0);

    g.append('g')
      .attr('transform', `translate(0,${innerHeight})`)
      .selectAll('text')
      .data(tickLabels)
      .enter()
      .append('text')
      .attr('x', (label: string) => x(label) ?? 0)
      .attr('y', 14)
      .attr('text-anchor', 'middle')
      .attr('font-size', 10)
      .attr('fill', 'currentColor')
      .text((label: string) => label);
  }, [widget.data, widget.color]);

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
      <div data-testid="line-graph-widget">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          className="h-auto w-full"
        />
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
