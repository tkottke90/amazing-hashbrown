import { useEffect, useRef } from 'preact/hooks';
import * as d3Selection from 'd3-selection';
import * as d3Shape from 'd3-shape';
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

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const sel = d3Selection.select(svg);
    sel.selectAll('*').remove();
    if (labels.length === 0) return;

    const pie = d3Shape.pie<number>().sort(null);
    const arc = d3Shape.arc<d3Shape.PieArcDatum<number>>().innerRadius(0).outerRadius(RADIUS);

    const g = sel.append('g').attr('transform', `translate(${RADIUS},${RADIUS})`);

    // Color Override (colors) applies positionally and cycles when shorter
    // than the label count; otherwise falls back to the app-wide
    // categorical palette per label index.
    g.selectAll('path')
      .data(pie(values))
      .enter()
      .append('path')
      .attr('d', (d) => arc(d) ?? '')
      .attr('fill', (_d, i) =>
        colors && colors.length > 0
          ? (colors[i % colors.length] ?? getDomainColor(i))
          : getDomainColor(i),
      );
  }, [labels, values, colors]);

  return (
    <div data-testid="pie-graph-widget" className="flex justify-center">
      <svg ref={svgRef} viewBox={`0 0 ${CHART_SIZE} ${CHART_SIZE}`} className="h-40 w-40" />
    </div>
  );
}
