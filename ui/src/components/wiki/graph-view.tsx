import { useEffect, useRef } from 'preact/hooks';
import { useSignal } from '@preact/signals';
import * as d3Force from 'd3-force';
import * as d3Selection from 'd3-selection';
import * as d3Zoom from 'd3-zoom';
import * as d3Drag from 'd3-drag';
import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3-force';
import type { D3ZoomEvent } from 'd3-zoom';
import { graphData, enabledDomainIds, domains, loadPage } from '@/hooks/use-wiki';
import type { GraphNode, GraphEdge } from '@/services/wiki-api';
import { getDomainColor } from './domain-filter';

// ---- D3 node/edge types ----

interface D3Node extends SimulationNodeDatum, GraphNode {
  edgeCount?: number;
}

type D3Edge = SimulationLinkDatum<D3Node> & GraphEdge;

// ---- Hover card ----

interface HoveredNode {
  node: D3Node;
  x: number;
  y: number;
}

interface Props {
  onOpenInEditor: (domainId: string, filename: string) => void;
}

const NODE_RADIUS_MIN = 6;
const NODE_RADIUS_MAX = 20;

export function GraphView({ onOpenInEditor }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const hoveredNode = useSignal<HoveredNode | null>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const enabled = enabledDomainIds.value;
    const domainList = domains.value;

    // Build domain → color index map
    const domainColorIndex = new Map<string, number>(domainList.map((d, i) => [d.id, i]));

    const allNodes = graphData.value.nodes.filter((n) => enabled.has(n.domainId));
    const allowedIds = new Set(allNodes.map((n) => n.id));
    const allEdges = graphData.value.edges.filter(
      (e) => enabled.has(e.domainId) && allowedIds.has(e.source) && allowedIds.has(e.target),
    );

    // Count edges per node for radius scaling
    const edgeCounts = new Map<string, number>();
    for (const e of allEdges) {
      edgeCounts.set(e.source as string, (edgeCounts.get(e.source as string) ?? 0) + 1);
      edgeCounts.set(e.target as string, (edgeCounts.get(e.target as string) ?? 0) + 1);
    }
    const maxEdges = Math.max(1, ...edgeCounts.values());

    const nodes: D3Node[] = allNodes.map((n) => ({
      ...n,
      edgeCount: edgeCounts.get(n.id) ?? 0,
    }));

    // Hidden derived_from edges excluded by default
    const visibleEdges: D3Edge[] = (allEdges as D3Edge[]).filter(
      (e) => e.type !== 'derived_from',
    );

    // Clear previous render
    const sel = d3Selection.select(svg);
    sel.selectAll('*').remove();

    const width = svg.clientWidth || 800;
    const height = svg.clientHeight || 600;

    // Arrow markers
    const defs = sel.append('defs');
    const markers = [
      { id: 'arrow-ref', color: '#94a3b8' },
      { id: 'arrow-con', color: '#ef4444' },
    ];
    for (const { id, color } of markers) {
      defs
        .append('marker')
        .attr('id', id)
        .attr('viewBox', '0 -5 10 10')
        .attr('refX', 20)
        .attr('refY', 0)
        .attr('markerWidth', 6)
        .attr('markerHeight', 6)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-5L10,0L0,5')
        .attr('fill', color);
    }

    const g = sel.append('g');

    // Zoom
    const zoom = d3Zoom
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        g.attr('transform', String(event.transform));
      });
    sel.call(zoom);

    // Edges
    const linkSel = g
      .append('g')
      .attr('class', 'edges')
      .selectAll<SVGLineElement, D3Edge>('line')
      .data(visibleEdges)
      .enter()
      .append('line')
      .attr('stroke', (d: D3Edge) => (d.type === 'contradicts' ? '#ef4444' : '#94a3b8'))
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', (d: D3Edge) => (d.type === 'contradicts' ? '4 3' : 'none'))
      .attr('marker-end', (d: D3Edge) =>
        d.type === 'contradicts' ? 'url(#arrow-con)' : 'url(#arrow-ref)',
      );

    // Nodes
    const nodeSel = g
      .append('g')
      .attr('class', 'nodes')
      .selectAll<SVGCircleElement, D3Node>('circle')
      .data(nodes)
      .enter()
      .append('circle')
      .attr('r', (d: D3Node) => {
        const t = (d.edgeCount ?? 0) / maxEdges;
        return NODE_RADIUS_MIN + t * (NODE_RADIUS_MAX - NODE_RADIUS_MIN);
      })
      .attr('fill', (d: D3Node) => {
        const idx = domainColorIndex.get(d.domainId) ?? 0;
        return getDomainColor(idx);
      })
      .attr('stroke', (d: D3Node) => (d.contested ? 'currentColor' : 'none'))
      .attr('stroke-width', (d: D3Node) => (d.contested ? 2 : 0))
      .attr('stroke-dasharray', (d: D3Node) => (d.contested ? '4 2' : 'none'))
      .attr('cursor', 'pointer')
      .on('mouseenter', (event: MouseEvent, d: D3Node) => {
        const rect = svg.getBoundingClientRect();
        hoveredNode.value = {
          node: d,
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        };
      })
      .on('mouseleave', () => {
        hoveredNode.value = null;
      });

    // Drag
    const drag = d3Drag
      .drag<SVGCircleElement, D3Node>()
      .on('start', (event: d3Drag.D3DragEvent<SVGCircleElement, D3Node, D3Node>, d: D3Node) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event: d3Drag.D3DragEvent<SVGCircleElement, D3Node, D3Node>, d: D3Node) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event: d3Drag.D3DragEvent<SVGCircleElement, D3Node, D3Node>, d: D3Node) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    nodeSel.call(drag);

    // Force simulation
    const simulation = d3Force
      .forceSimulation<D3Node>(nodes)
      .force(
        'link',
        d3Force
          .forceLink<D3Node, D3Edge>(visibleEdges)
          .id((d: D3Node) => d.id)
          .distance(80),
      )
      .force('charge', d3Force.forceManyBody<D3Node>().strength(-200))
      .force('center', d3Force.forceCenter<D3Node>(width / 2, height / 2))
      .on('tick', () => {
        linkSel
          .attr('x1', (d: D3Edge) => (d.source as D3Node).x ?? 0)
          .attr('y1', (d: D3Edge) => (d.source as D3Node).y ?? 0)
          .attr('x2', (d: D3Edge) => (d.target as D3Node).x ?? 0)
          .attr('y2', (d: D3Edge) => (d.target as D3Node).y ?? 0);

        nodeSel.attr('cx', (d: D3Node) => d.x ?? 0).attr('cy', (d: D3Node) => d.y ?? 0);
      });

    return () => {
      simulation.stop();
    };
  }, [graphData.value, enabledDomainIds.value]);

  const hovered = hoveredNode.value;

  return (
    <div class="relative h-full w-full">
      <svg ref={svgRef} class="h-full w-full" />

      {hovered && (
        <div
          class="pointer-events-none absolute z-10 w-56 rounded-lg border border-border bg-card p-3 shadow-lg text-sm"
          style={{
            left: Math.min(hovered.x + 12, window.innerWidth - 250),
            top: Math.max(hovered.y - 12, 8),
          }}
        >
          <div class="font-semibold text-foreground truncate">{hovered.node.title}</div>
          <div class="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
            <span class="rounded bg-muted px-1.5 py-0.5">{hovered.node.type}</span>
            <span class="rounded bg-muted px-1.5 py-0.5">{hovered.node.domainId}</span>
            {hovered.node.confidence && (
              <span class="rounded bg-muted px-1.5 py-0.5">{hovered.node.confidence}</span>
            )}
            {hovered.node.contested && (
              <span class="rounded bg-destructive/20 px-1.5 py-0.5 text-destructive">
                contested
              </span>
            )}
          </div>
          {hovered.node.tags.length > 0 && (
            <div class="mt-1.5 flex flex-wrap gap-1 text-xs text-muted-foreground">
              {hovered.node.tags.slice(0, 4).map((tag) => (
                <span key={tag} class="rounded-full border border-border px-1.5 py-0.5">
                  {tag}
                </span>
              ))}
            </div>
          )}
          <button
            type="button"
            class="pointer-events-auto mt-2 w-full rounded bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90 transition-colors"
            onClick={() => onOpenInEditor(hovered.node.domainId, hovered.node.id)}
          >
            Open in editor
          </button>
        </div>
      )}

      {graphData.value.nodes.length === 0 && (
        <div class="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          No pages yet. Use the chat to add content to the wiki.
        </div>
      )}
    </div>
  );
}
