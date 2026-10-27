import { useEffect, useRef } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import * as d3Selection from 'd3-selection';
import * as d3Shape from 'd3-shape';
import { cn } from '@/lib/utils';
import { getDomainColor } from '@/pages/wiki/domain-filter';

interface PieChartProps {
  labels: string[];
  values: number[];
  colors?: string[];
}

const CHART_SIZE = 160;
const RADIUS = CHART_SIZE / 2;

// Shared pie-drawing presentational piece (composition over customization,
// AGENTS.md) — composed by the manual Pie Graph widget (CSV-sourced data),
// the System Widget's pie-graph case, and the drawer's Metric live preview,
// instead of each duplicating this d3 effect.
export function PieChart({ labels, values, colors }: PieChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const hoveredIndex = useSignal<number | null>(null);
  const hoverPos = useSignal<{ x: number; y: number } | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Color Override (colors) applies positionally and cycles when shorter
  // than the label count; otherwise falls back to the app-wide
  // categorical palette per label index. Shared by the D3 fill and the
  // legend swatch so the two can never disagree.
  function resolvedColor(i: number): string {
    return colors && colors.length > 0
      ? (colors[i % colors.length] ?? getDomainColor(i))
      : getDomainColor(i);
  }

  function cancelClose() {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function scheduleClose() {
    closeTimerRef.current = setTimeout(() => {
      hoveredIndex.value = null;
    }, 200);
  }

  // Single entry point for both the slice and the legend row (linked
  // hover): whichever one is hovered sets the exact same two signals, so
  // there's one hover state, not two kept in sync. Positioned relative to
  // the chart+legend wrapper, not just the svg, since a legend row isn't
  // inside it.
  function setHovered(index: number, event: MouseEvent) {
    cancelClose();
    const wrapper = (event.currentTarget as Element).closest<HTMLElement>(
      '[data-testid="pie-graph-widget"]',
    );
    const rect = (wrapper ?? (event.currentTarget as Element)).getBoundingClientRect();
    hoveredIndex.value = index;
    hoverPos.value = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function percent(i: number): number {
    const total = values.reduce((a, b) => a + b, 0);
    return total === 0 ? 0 : Math.round((values[i]! / total) * 100);
  }

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const sel = d3Selection.select(svg);
    sel.selectAll('*').remove();
    if (labels.length === 0) return;

    const pie = d3Shape.pie<number>().sort(null);
    const arc = d3Shape.arc<d3Shape.PieArcDatum<number>>().innerRadius(0).outerRadius(RADIUS);

    const g = sel.append('g').attr('transform', `translate(${RADIUS},${RADIUS})`);

    g.selectAll('path')
      .data(pie(values))
      .enter()
      .append('path')
      .attr('d', (d) => arc(d) ?? '')
      .attr('fill', (_d, i) => resolvedColor(i))
      .on('mouseenter', (event: MouseEvent, d) => setHovered(d.index, event))
      .on('mousemove', (event: MouseEvent, d) => setHovered(d.index, event))
      .on('mouseleave', () => scheduleClose());
  }, [labels, values, colors]);

  // Separate from the draw effect above on purpose: it only ever updates
  // an `opacity` attribute on already-existing `path` elements (reading
  // the index straight off each one's already-bound PieArcDatum), never
  // re-runs the pie()/enter()/append() join. Folding this into the draw
  // effect's own dependency array would rejoin — and so destroy and
  // recreate — the exact `path` the pointer is currently over on every
  // hover change.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    d3Selection
      .select(svg)
      .selectAll<SVGPathElement, d3Shape.PieArcDatum<number>>('path')
      .attr('opacity', (d) =>
        hoveredIndex.value === null || hoveredIndex.value === d.index ? 1 : 0.35,
      );
  }, [hoveredIndex.value]);

  return (
    <div data-testid="pie-graph-widget" className="relative flex items-center gap-4">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${CHART_SIZE} ${CHART_SIZE}`}
        className="h-40 w-40 shrink-0"
      />
      <ul
        data-testid="pie-chart-legend"
        className="flex max-h-40 min-w-0 flex-1 flex-col gap-0.5 overflow-y-auto text-xs"
      >
        {labels.map((label, i) => (
          <li
            key={label}
            data-testid="pie-chart-legend-row"
            className={cn(
              'flex items-center gap-1.5 truncate rounded px-1 py-0.5',
              hoveredIndex.value === i && 'bg-muted',
            )}
            onMouseEnter={(e) => setHovered(i, e)}
            onMouseLeave={scheduleClose}
          >
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: resolvedColor(i) }}
            />
            <span className="truncate">{label}</span>
            <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{values[i]}</span>
          </li>
        ))}
      </ul>
      {hoveredIndex.value !== null && hoverPos.value && (
        <div
          data-testid="pie-chart-tooltip"
          className="absolute z-10 rounded-md border border-border bg-card px-2 py-1 text-xs shadow-lg"
          style={{ left: hoverPos.value.x + 8, top: hoverPos.value.y - 8 }}
          onMouseEnter={cancelClose}
        >
          <div className="font-medium">{labels[hoveredIndex.value]}</div>
          <div className="text-muted-foreground">
            {values[hoveredIndex.value]} ({percent(hoveredIndex.value)}%)
          </div>
        </div>
      )}
    </div>
  );
}
