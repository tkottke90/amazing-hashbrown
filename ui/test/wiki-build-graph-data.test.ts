import { buildGraphData, type D3Edge } from '@/pages/wiki/build-graph-data';
import type { GraphNode, GraphEdge } from '@/services/wiki-api';

const DOMAIN_A = 'domain-a';
const DOMAIN_B = 'domain-b';

const nodes: GraphNode[] = [
  { id: 'n1', title: 'Node 1', type: 'concept', tags: [], domainId: DOMAIN_A },
  { id: 'n2', title: 'Node 2', type: 'concept', tags: [], domainId: DOMAIN_A },
  { id: 'n3', title: 'Node 3', type: 'concept', tags: [], domainId: DOMAIN_B },
];

const edges: GraphEdge[] = [
  { source: 'n1', target: 'n2', type: 'references', domainId: DOMAIN_A },
  { source: 'n2', target: 'n3', type: 'contradicts', domainId: DOMAIN_B },
  { source: 'n1', target: 'n3', type: 'derived_from', domainId: DOMAIN_A },
];

const ALL_DOMAINS = new Set([DOMAIN_A, DOMAIN_B]);

/** Simulates the mutation d3-force's forceLink performs in place on the
 * edges it's given: replaces the string source/target ids with plain
 * node-shaped objects. Used to prove buildGraphData's clones can be
 * mutated without corrupting the caller's original edges array. */
function simulateForceLinkMutation(mutableEdges: D3Edge[]): void {
  for (const e of mutableEdges) {
    // @ts-expect-error -- intentionally violating the string-typed contract,
    // mirroring what d3-force does to the objects it's given.
    e.source = { id: e.source };
    // @ts-expect-error -- see above.
    e.target = { id: e.target };
  }
}

describe('buildGraphData', () => {
  it('returns edges that are distinct object references from the input array [unit]', () => {
    const result = buildGraphData(nodes, edges, ALL_DOMAINS);

    for (const returnedEdge of result.edges) {
      const original = edges.find(
        (e) => e.source === returnedEdge.source && e.target === returnedEdge.target,
      );
      expect(original).toBeDefined();
      expect(returnedEdge).not.toBe(original);
    }
  });

  it('does not leak mutation of a returned edge back into the original input array [unit]', () => {
    const result = buildGraphData(nodes, edges, ALL_DOMAINS);
    simulateForceLinkMutation(result.edges);

    for (const original of edges) {
      expect(typeof original.source).toBe('string');
      expect(typeof original.target).toBe('string');
    }
  });

  it('excludes derived_from edges from the returned edge set [unit]', () => {
    const result = buildGraphData(nodes, edges, ALL_DOMAINS);

    expect(result.edges.some((e) => e.type === 'derived_from')).toBe(false);
    expect(result.edges).toHaveLength(2);
  });

  it('excludes edges referencing a node filtered out by domain [unit]', () => {
    const result = buildGraphData(nodes, edges, new Set([DOMAIN_A]));

    expect(result.nodes.map((n) => n.id).sort()).toEqual(['n1', 'n2']);
    // n1 -> n2 (references) survives, since both endpoints stay visible.
    // n2 -> n3 (contradicts) and n1 -> n3 (derived_from) are excluded because
    // n3's domain is disabled.
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({ source: 'n1', target: 'n2' });
  });

  it('computes edgeCount per node correctly, including derived_from edges [unit]', () => {
    const result = buildGraphData(nodes, edges, ALL_DOMAINS);
    const edgeCountById = new Map(result.nodes.map((n) => [n.id, n.edgeCount]));

    // edgeCount is computed from all domain-matched edges, including
    // derived_from ones (they still affect radius scaling), even though
    // derived_from edges are excluded from the rendered/returned edge set.
    // n1: references (n1-n2) + derived_from (n1-n3) = 2
    expect(edgeCountById.get('n1')).toBe(2);
    // n2: references (as target) + contradicts (as source) = 2
    expect(edgeCountById.get('n2')).toBe(2);
    // n3: contradicts (as target) + derived_from (as target) = 2
    expect(edgeCountById.get('n3')).toBe(2);
  });

  it('returns correct, non-empty edges across repeated calls simulating a tab-switch remount [unit]', () => {
    const first = buildGraphData(nodes, edges, ALL_DOMAINS);
    simulateForceLinkMutation(first.edges);

    // A remount re-runs buildGraphData against the same underlying arrays.
    const second = buildGraphData(nodes, edges, ALL_DOMAINS);

    expect(second.edges).toHaveLength(2);
    for (const e of second.edges) {
      expect(typeof e.source).toBe('string');
      expect(typeof e.target).toBe('string');
    }
  });

  it('returns correct edges across a visibility toggle off then back on [unit]', () => {
    const before = buildGraphData(nodes, edges, ALL_DOMAINS);
    simulateForceLinkMutation(before.edges);

    const toggledOff = buildGraphData(nodes, edges, new Set([DOMAIN_A]));
    expect(toggledOff.edges).toHaveLength(1);

    const toggledBackOn = buildGraphData(nodes, edges, ALL_DOMAINS);
    expect(toggledBackOn.edges).toHaveLength(2);
    for (const e of toggledBackOn.edges) {
      expect(typeof e.source).toBe('string');
      expect(typeof e.target).toBe('string');
    }
  });
});
