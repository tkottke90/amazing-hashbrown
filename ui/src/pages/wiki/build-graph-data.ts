import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3-force';
import type { GraphNode, GraphEdge } from '@/services/wiki-api';

// ---- D3 node/edge types ----

export interface D3Node extends SimulationNodeDatum, GraphNode {
  edgeCount?: number;
}

export type D3Edge = SimulationLinkDatum<D3Node> & GraphEdge;

// Node radius scales linearly with edgeCount, from a minimum size for
// unconnected nodes up to a maximum for the most-connected node in the
// visible graph.
export const NODE_RADIUS_MIN = 6;
export const NODE_RADIUS_MAX = 20;

/** Visual radius for a node with `edgeCount` edges, given the graph's max
 * edge count. Shared by the node's rendered circle and forceCollide's
 * collision radius so the two can never drift apart. */
export function nodeRadius(edgeCount: number, maxEdges: number): number {
  const t = edgeCount / maxEdges;
  return NODE_RADIUS_MIN + t * (NODE_RADIUS_MAX - NODE_RADIUS_MIN);
}

/**
 * Anchor point per enabled wiki/domain, arranged on a circle so each wiki's
 * cluster settles around a distinct point instead of every node sharing one
 * global center. A single domain anchors at the canvas center — the same
 * point the old global forceCenter used — so single-wiki views are visually
 * unchanged.
 */
export function computeDomainAnchors(
  domainIds: string[],
  width: number,
  height: number,
): Map<string, { x: number; y: number }> {
  const anchors = new Map<string, { x: number; y: number }>();
  const cx = width / 2;
  const cy = height / 2;
  const radius = domainIds.length > 1 ? Math.min(width, height) * 0.3 : 0;
  domainIds.forEach((id, i) => {
    const angle = (2 * Math.PI * i) / domainIds.length;
    anchors.set(id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
  });
  return anchors;
}

/**
 * Turns raw wiki graph data into what the D3 force simulation consumes:
 * nodes/edges filtered to the enabled domains, with per-node edge counts for
 * radius scaling and `derived_from` edges hidden by default.
 *
 * Every returned edge is a shallow clone of its source `GraphEdge` — d3-force's
 * `forceLink` mutates `source`/`target` from string ids to node object
 * references in place during simulation setup, so returning the original
 * objects would leak that mutation back into whatever array `edges` came
 * from (e.g. a signal), corrupting it for any later call. See issue #109.
 */
export function buildGraphData(
  nodes: GraphNode[],
  edges: GraphEdge[],
  enabledDomainIds: Set<string>,
): { nodes: D3Node[]; edges: D3Edge[] } {
  const allNodes = nodes.filter((n) => enabledDomainIds.has(n.domainId));
  const allowedIds = new Set(allNodes.map((n) => n.id));
  const allEdges = edges.filter(
    (e) => enabledDomainIds.has(e.domainId) && allowedIds.has(e.source) && allowedIds.has(e.target),
  );

  // Count edges per node for radius scaling
  const edgeCounts = new Map<string, number>();
  for (const e of allEdges) {
    edgeCounts.set(e.source, (edgeCounts.get(e.source) ?? 0) + 1);
    edgeCounts.set(e.target, (edgeCounts.get(e.target) ?? 0) + 1);
  }

  const d3Nodes: D3Node[] = allNodes.map((n) => ({
    ...n,
    edgeCount: edgeCounts.get(n.id) ?? 0,
  }));

  // Hidden derived_from edges excluded by default
  const d3Edges: D3Edge[] = allEdges
    .filter((e) => e.type !== 'derived_from')
    .map((e) => ({ ...e }));

  return { nodes: d3Nodes, edges: d3Edges };
}
