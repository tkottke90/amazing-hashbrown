# Wiki Graph Edges Disappearing After Tab Switch / Visibility Toggle — Design

**Date:** 2026-08-30
**Status:** Approved
**Issue:** [#109 — Bug: Wiki graph edges disappear after certain graph interactions](https://github.com/tkottke90/amazing-hashbrown/issues/109)

---

## 1. Problem & Root Cause

On `/wiki`, the graph view (`ui/src/pages/wiki/graph-view.tsx`) renders correctly on first load, then loses all edges (nodes stay visible) after either:

1. switching to the Documents tab and back to Graph, or
2. toggling a wiki's visibility via the domain filter.

**Root cause:** the graph's single `useEffect` (lines 40-203) builds its working edge list from `graphData.value.edges` via `.filter()`:

```typescript
// graph-view.tsx:50-54
const allNodes = graphData.value.nodes.filter((n) => enabled.has(n.domainId));
const allowedIds = new Set(allNodes.map((n) => n.id));
const allEdges = graphData.value.edges.filter(
  (e) => enabled.has(e.domainId) && allowedIds.has(e.source) && allowedIds.has(e.target),
);
```

`.filter()` returns a new array, but each edge is the _same object reference_ held by the `graphData` signal. Those shared objects are handed straight to `d3Force.forceLink(visibleEdges)` (line 184), which — per d3-force's documented behavior — mutates `edge.source`/`edge.target` in place, resolving them from string ids to node object references during simulation setup. Because the edges were never cloned, this mutation persists on the objects inside `graphData.value.edges` itself.

On the _next_ effect run — a remount from switching tabs (Graph/Documents render conditionally in `ui/src/pages/wiki/index.tsx:122-126`, so leaving Graph fully unmounts it) or a re-run triggered by `enabledDomainIds.value` changing (`ui/src/pages/wiki/domain-filter.tsx:30-33` → `use-wiki.ts:73-81`) — the filter at line 52-53 checks `allowedIds.has(e.source)` against a `Set<string>` of node ids. Since `e.source` is now a node object, not a string, the check always fails, `allEdges`/`visibleEdges` come back empty, and no `<line>` elements render. Node filtering is unaffected (it only checks `n.domainId`, which is never touched by the mutation), matching the reported symptom exactly.

A secondary casualty: `edgeCounts` (lines 57-61), which drives node radius scaling, is also computed from `e.source`/`e.target` and silently goes wrong on any re-run for the same reason.

---

## 2. Fix: Extract a Pure, Cloning `buildGraphData` Helper

New file `ui/src/pages/wiki/build-graph-data.ts` extracts the "turn `graphData` + `enabledDomainIds` into what the simulation consumes" logic out of the effect into a pure function:

```typescript
export function buildGraphData(
  nodes: GraphNode[],
  edges: GraphEdge[],
  enabledDomainIds: Set<string>,
): { nodes: D3Node[]; edges: D3Edge[] };
```

It performs the same filtering, edge-count computation, and `derived_from` exclusion as today, with one change: edges are shallow-cloned (`{ ...e }`) before being returned. Callers (including d3-force) can then freely mutate the returned edge objects — including the `source`/`target` id→object resolution `forceLink` performs — without ever touching the objects `graphData.value.edges` holds. The `D3Node`/`D3Edge` type definitions move into this new file alongside the function; `graph-view.tsx` imports them from there.

`graph-view.tsx`'s effect shrinks to: call `buildGraphData(graphData.value.nodes, graphData.value.edges, enabled)`, then feed the result into the existing d3 rendering/simulation code (defs, zoom, edge/node selections, drag, `forceSimulation`) unchanged.

This also fixes the `edgeCounts` miscounting as a side effect, since counts are now always computed from edges that are guaranteed never-mutated at the point of counting.

**Why extract instead of an inline `.map(e => ({...e}))`:** the resulting function has no DOM/d3/SVG dependency, so it's directly unit-testable per this repo's default test type (a single function in isolation), rather than requiring a jsdom+SVG-backed component test to exercise the same logic indirectly.

---

## 3. Testing

### Unit (`ui/test/wiki-build-graph-data.test.ts`, new)

This is the first unit test file in the `ui/` workspace — Jest is already configured (`ui/jest.config.js`) but has no test files yet. Note: `ui/jest.config.js`'s `testMatch` only discovers tests under the flat `ui/test/` directory, not colocated with `ui/src` — this corrects an earlier draft of this section, which stated a colocated path.

- Returned edges are distinct object references from the input `edges` array (proves cloning happened).
- Mutating a field (e.g. `source`) on a returned edge does not affect the corresponding object in the original input array.
- Calling `buildGraphData` twice in a row with the same inputs (simulating a tab-switch remount) returns a correct, non-empty edge list both times.
- Calling it once, then again with a smaller `enabledDomainIds` and again with the original set restored (simulating a visibility toggle off/on), returns correct edges each time — including after simulating the id→object mutation `forceLink` performs on the first call's returned edges, to prove it doesn't leak into the second call.
- Existing behavior is preserved: `derived_from` edges are excluded from the returned edge set; edges referencing a filtered-out node (via `domainId`) are excluded; `edgeCount` is computed correctly per node.

### E2E (`e2e/tests/wiki-graph.spec.ts`, new)

No wiki e2e spec exists yet. Following `e2e/AGENTS.md`'s route-mocking pattern, mock the wiki graph API response with a small fixed set of nodes/edges across two domains. Tag `@user-workflow`.

- **Tab-switch scenario:** load the wiki page on the Graph tab, assert the expected edge count is rendered; switch to Documents, switch back to Graph; assert the same edge count is still rendered.
- **Visibility-toggle scenario:** with the graph loaded, toggle a domain off via the domain filter, assert edges among the remaining visible nodes still render; toggle it back on, assert edges are still correct (including edges touching the restored domain).

---

## 4. Files Changed

| File                                          | Change                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui/src/pages/wiki/build-graph-data.ts` (new) | Pure `buildGraphData()` extracted from `graph-view.tsx`'s effect; clones edges before returning; hosts the `D3Node`/`D3Edge` type definitions                                                                                                                                                                                           |
| `ui/src/pages/wiki/graph-view.tsx`            | Effect calls `buildGraphData()` instead of inlining the filter/count logic; imports `D3Node`/`D3Edge` from the new file; adds `data-testid="graph-edges"`/`"graph-nodes"` to the edge/node `<g>` groups so the new e2e spec can select rendered edges/nodes reliably (per `e2e/AGENTS.md`'s selector priority — no CSS-class selectors) |
| `ui/test/wiki-build-graph-data.test.ts` (new) | Unit coverage per §3                                                                                                                                                                                                                                                                                                                    |
| `e2e/tests/wiki-graph.spec.ts` (new)          | E2E coverage per §3                                                                                                                                                                                                                                                                                                                     |
| `e2e/AGENTS.md`                               | Records the two new `data-testid` values in the "Known `data-testid` attributes" table                                                                                                                                                                                                                                                  |

---

## 5. Out of Scope

- Any change to d3-force's own mutation behavior, or switching away from d3-force — the fix works with that behavior by isolating its effects, not by avoiding the library.
- Broader test coverage for the rest of `graph-view.tsx` (drag, zoom, hover card) — only the logic implicated in this bug is covered.
- Any change to `domain-filter.tsx` or `use-wiki.ts` — both already behave correctly; the bug is entirely in how `graph-view.tsx` consumes their output.
