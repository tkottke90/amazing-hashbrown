# Cross-Wiki Edges & Disjoint Force-Directed Graph Layout — Design

**Date:** 2026-09-08
**Status:** Approved
**Issue:** [#148 — Enhancement - Support cross-wiki edges and disjoint force-directed graph layout](https://github.com/tkottke90/amazing-hashbrown/issues/148)

---

## 1. Problem

`lib/llm-wiki/` treats each wiki as an independently rooted page store. `LlmWiki.buildGraph()` only ever resolves `[[wikilinks]]` against its own page list, so a link typed against another wiki's page never becomes a graph edge — `addCrossLink()` will happily write the link text, but it silently fails to resolve and gets flagged as an error-severity `broken_links` lint finding instead of becoming a usable connection. `wiki_add_cross_link` and the merged graph endpoint (`GET /api/v1/wiki/graph`) reinforce the single-wiki assumption.

Separately, the graph view (`ui/src/pages/wiki/graph-view.tsx`) renders every wiki's nodes in one `d3-force` simulation with a single global `forceCenter`. `forceCenter` only recenters the simulation's average position — it does nothing to bound how far apart two unconnected clusters can spread, since nothing opposes `forceManyBody`'s repulsion between them. Dragging a node calls `simulation.alphaTarget(0.3).restart()`, reheating the simulation and giving that repulsion another window to act before it cools; repeated dragging drives unconnected wikis' clusters progressively further apart with nothing to pull them back. This is a pre-existing bug independent of cross-wiki edges (it would already reproduce with two unconnected wikis today), and it directly conflicts with the goal of a legible multi-wiki graph.

## 2. Chosen Direction

Per the issue: an explicit external-reference edge type keyed on `wikiId:pagePath`, resolved into real `GraphEdge`s inside `buildGraph()` via a `WikiRegistry` lookup of the target wiki. This is additive — it does not touch existing single-wiki resolution for wikis that don't use cross-wiki references.

On the frontend: replace the single global centering force with per-domain anchor forces plus collision detection, which separates each wiki's cluster visually **and** fixes the drag-drift bug, since an anchor force always eventually wins regardless of how much energy a drag injects.

---

## 3. Reference Syntax

Extend the existing `[[wikilink]]` syntax with an optional `wikiId:` prefix:

```markdown
See [[other-wiki:entities/large-language-model]] for background.
```

Same authoring mechanism authors already use for intra-wiki links — crossing wikis just adds a namespace. No new frontmatter field, no second linking mechanism.

`lib/llm-wiki/src/internal/wikilinks.ts` changes:

- `normalizeLink`/a new `parseExternalRef(target: string): { wikiId: string; pagePath: string } | null` splits on the first `:` when present. A bare `entities/foo` (no colon) is never treated as external — this matches today's page paths, none of which contain colons.
- `resolveLinkTarget` behavior for same-wiki links is unchanged.

This same parsing is reused wherever `resolveLinkTarget` is already called — including the `contradictions` frontmatter array in `buildGraph()` — so a page can declare a cross-wiki contradiction with the same `wikiId:pagePath` form, at no extra implementation cost.

---

## 4. Wiki Self-Identity

`LlmWiki` currently only knows its filesystem `basePath`; the id↔path mapping lives entirely in `WikiRegistry`. Node ids (§5) need the wiki's own id, so:

- `LoadOptions` and `CreateOptions` gain an optional `wikiId?: string`.
- `LlmWiki.load()`/`create()` store `opts.wikiId ?? path.basename(base)` as `this.wikiId`.
- `WikiRegistry.load()` and `WikiRegistry.create()` always pass their own registry id explicitly, so the fallback only applies to a standalone `LlmWiki.load()` call made outside a registry (tests, scripts) — the same convention registry ids already default to (`WikiEntry.path` defaults to `id`).

---

## 5. Node & Edge Identity

`GraphNode.id` changes from a bare page stem (`entities/foo`) to `${wikiId}:${pageStem}`, **everywhere** — including single-wiki `buildGraph()` output, not just cross-wiki targets. This is a breaking change to the `GraphNode`/`GraphEdge` id format but `GraphNode.id` was never a stable identifier outside this graph.

Benefits:

- A cross-wiki `GraphEdge.target` is just another id — no special shape, no new fields on `GraphEdge`.
- Removes a latent bug for free: today, two wikis with a same-named page (`entities/foo.md` in both) would collide in the merged graph's node list, since ids aren't currently namespaced across domains.

```ts
// buildGraph()
const node: GraphNode = {
  id: `${this.wikiId}:${pageStem(page.filename)}`,
  title: page.title,
  // ...unchanged
};
```

A cross-wiki edge is then detectable purely by comparing the `wikiId:` prefix of `source` vs `target` — no new `GraphEdge.type` is needed for styling or filtering purposes (see §8).

---

## 6. Graph Resolution (`buildGraph`)

```ts
export interface BuildGraphOptions {
  includeSources?: boolean;
  /** When supplied, external `[[wikiId:pagePath]]` references resolve into
   *  real cross-wiki edges. Omitted: external references are left unresolved. */
  registry?: WikiRegistry;
}
```

Inside the existing wikilink loop:

```ts
for (const link of extractWikilinks(page.content)) {
  const ext = parseExternalRef(link);
  if (ext) {
    if (opts.registry) {
      const targetWiki = await opts.registry.load(ext.wikiId).catch(() => null);
      const targetPages = targetWiki ? (await targetWiki.listPages()).map((p) => p.filename) : [];
      const resolved = targetWiki ? resolveLinkTarget(ext.pagePath, targetPages) : null;
      if (resolved) addEdge(id, `${ext.wikiId}:${pageStem(resolved)}`, 'references');
    }
    continue;
  }
  // ...existing same-wiki resolution, unchanged
}
```

The same `parseExternalRef` branch is applied to the `contradictions` loop, producing `contradicts`-type cross-wiki edges.

`LlmWiki` takes no hard dependency on `WikiRegistry` — this keeps it usable standalone (as today, e.g. in tests) when `registry` is omitted; external references are then simply left unresolved, matching current behavior for any link `buildGraph()` can't resolve.

`api/src/routes/v1/wiki.route.ts`'s `GET /api/v1/wiki/graph` passes `registry` into every `wiki.buildGraph()` call so cross-wiki edges resolve in the merged graph. The existing per-domain node/edge merge and metadata-type filtering logic is otherwise unchanged — it continues to work because node ids are now globally unique across domains.

---

## 7. Lint: `cross_wiki_links` Check

A new, dedicated `LintCheckId`: `cross_wiki_links` — kept separate from `broken_links` so intra- vs cross-wiki broken-reference findings stay distinguishable by `check` field.

`LintContext` gains an optional field:

```ts
export interface LintContext {
  // ...existing fields
  /** Other registered wikis' page paths, keyed by wiki id. Populated only
   *  when linting through WikiRegistry. */
  externalPages?: Map<string, string[]>;
}
```

`WikiRegistry.lint()` populates it by loading every other registered wiki and collecting its page list (mirroring how it already injects `registryWikiIds`/`onDiskDirs` for `registry_sync`):

```ts
async lint(id: string): Promise<LintReport> {
  const wiki = await this.load(id);
  const externalPages = new Map<string, string[]>();
  for (const w of this.list()) {
    if (w.id === id) continue;
    const other = await this.load(w.id).catch(() => null);
    if (other) externalPages.set(w.id, (await other.listPages()).map((p) => p.filename));
  }
  return wiki.lint({
    wikiIds: this.data.wikis.map((w) => w.id),
    onDiskDirs: await this.onDiskWikiDirs(),
    externalPages,
  });
}
```

`checkCrossWikiLinks(ctx)` in `internal/lint/checks.ts` walks every page's wikilinks, and for each that parses as external:

- If `ctx.externalPages` is absent (standalone `wiki.lint()` call, no registry): skip entirely — cannot validate what it can't see, same "best effort without registry" shape `checkRegistrySync` already uses.
- If `ctx.externalPages.get(wikiId)` is undefined: error finding — "references unknown wiki".
- If defined but `resolveLinkTarget(pagePath, pages)` fails: error finding — "references a page that does not exist in wiki `wikiId`".

`runLint()` registers `checkCrossWikiLinks` alongside the other checks.

---

## 8. Frontend: Disjoint Layout & Collision

`ui/src/pages/wiki/graph-view.tsx`'s force simulation changes:

- Compute one anchor point per **enabled** domain, arranged in a circle sized to the domain count (a single enabled domain reduces to one anchor at canvas center — today's `forceCenter` behavior, unchanged when only one wiki is visible).
- Replace the single `forceCenter` with per-node `forceX`/`forceY` targeting the node's own domain anchor, at a weak strength (~0.08) so `forceLink` can still pull cross-wiki-linked nodes toward each other without fully overriding cluster grouping.
- Add `forceCollide` sized to each node's rendered radius, preventing node overlap.

```ts
const domainList = domains.value.filter((d) => enabledDomainIds.value.has(d.id));
const anchors = new Map<string, { x: number; y: number }>();
domainList.forEach((d, i) => {
  const angle = (2 * Math.PI * i) / domainList.length;
  const r = domainList.length > 1 ? Math.min(width, height) * 0.3 : 0;
  anchors.set(d.id, { x: width / 2 + r * Math.cos(angle), y: height / 2 + r * Math.sin(angle) });
});

const simulation = d3Force
  .forceSimulation<D3Node>(nodes)
  .force('link', d3Force.forceLink<D3Node, D3Edge>(visibleEdges).id((d) => d.id).distance(80))
  .force('charge', d3Force.forceManyBody<D3Node>().strength(-200))
  .force('collide', d3Force.forceCollide<D3Node>((d) => radiusFor(d, maxEdges) + 2))
  .force('x', d3Force.forceX<D3Node>((d) => anchors.get(d.domainId)?.x ?? width / 2).strength(0.08))
  .force('y', d3Force.forceY<D3Node>((d) => anchors.get(d.domainId)?.y ?? height / 2).strength(0.08));
```

This directly fixes the reported drag-drift bug: the anchor force is always present and always pulls back toward the domain's anchor, so repeated dragging can no longer accumulate unbounded cluster separation the way unopposed `forceManyBody` + a mean-only `forceCenter` did.

**Cross-wiki edge styling:** detected by comparing the `wikiId:` prefix of `edge.source`/`edge.target` (no new `GraphEdge.type`). Rendered with a distinct color (`#0ea5e9`, chosen to avoid clashing with the existing domain fill palette or the `references`/`contradicts` edge colors) and its own arrow marker (`arrow-cross`), so a cross-wiki connection reads as categorically different at a glance from an intra-wiki reference.

**"Open in editor" fix:** the hover-card button currently does `onOpenInEditor(hovered.node.domainId, hovered.node.id)`, which flows into `fetchPage(domainId, pagePath)` expecting a bare relative file path. Since `node.id` is now `${domainId}:${pageStem}`, the click handler strips the known `domainId` prefix before calling `onOpenInEditor`:

```ts
onOpenInEditor(hovered.node.domainId, hovered.node.id.slice(hovered.node.domainId.length + 1));
```

`ui/src/pages/wiki/build-graph-data.ts`'s filtering logic (domain-enabled check, `derived_from` exclusion, edge-count computation) needs no structural change — it already operates on whatever `id`/`domainId` values are present, and a cross-wiki edge is naturally dropped by the existing filter whenever either endpoint's domain is disabled (both endpoints must be in `allowedIds`), which is the same behavior as any other edge today.

---

## 9. Agent Tool (`wiki_add_cross_link`)

No signature change to `LlmWiki.addCrossLink` or the tool's Zod schema — `addCrossLink` never validated that `toPage` resolves (intra-wiki or not), by design; validation is deferred to lint (§7). A `toPage` of `other-wiki:entities/foo` already works today because `pageStem()` only strips a trailing `.md`, so it passes the colon through unchanged into the inserted `[[other-wiki:entities/foo]]` link text.

Only the tool's description changes, to document the syntax:

```ts
const WikiAddCrossLinkSchema = z.object({
  wikiId: z.string().describe('Wiki domain ID that fromPage belongs to.'),
  fromPage: z.string().describe('Path of the page to add the link from, relative to its wiki root.'),
  toPage: z
    .string()
    .describe(
      'Path or slug of the page to link to, relative to its wiki root. ' +
        "To link to a page in a DIFFERENT wiki, prefix with that wiki's id " +
        "and a colon, e.g. 'other-wiki-id:entities/foo' — use wiki_locate to find valid wiki ids.",
    ),
});
```

`allowedWikiId` session write-scoping is unaffected: it already only checks `wikiId` (the wiki `fromPage` belongs to, i.e. the one actually being written to) against the caller's allowed wiki — referencing a different wiki's page was never a write to that wiki, only a mention of it.

---

## 10. Testing

### `lib/llm-wiki` (Mocha, flat `lib/llm-wiki/test/` directory)

- `wikilinks`-level parsing: `parseExternalRef` splits `wikiId:pagePath` correctly; a bare path (no colon) returns `null`; an edge case like a Windows-style path is not misparsed (no colons expected in practice, but the split must be first-colon-only).
- `llm-wiki.test.ts`: `buildGraph()` without `registry` leaves an external reference unresolved (no edge, no throw); with a `registry` mock/stub, resolves into a `references` edge whose `target` is the namespaced id; an external reference to a nonexistent wiki id or nonexistent page produces no edge; node ids are namespaced (`${wikiId}:${pageStem}`) in single-wiki output.
- `registry.test.ts`: `WikiRegistry.load()`/`create()` pass their id into `LlmWiki`; `lint()` populates `externalPages` from every other registered wiki.
- `lint.test.ts`: `checkCrossWikiLinks` — unknown wiki id → error finding; known wiki, unknown page → error finding; valid cross-wiki reference → no finding; no `externalPages` in context → check is silently skipped.

### `api/src/routes/v1/wiki.route.test.ts` (new — no existing test file covers this route)

- `GET /api/v1/wiki/graph` merges cross-wiki edges between two registered wikis given a fixture with a `[[wikiId:pagePath]]` reference.
- Existing single-wiki merge/filter behavior (metadata-type node exclusion) is unaffected.

### `api/src/agents/tools/wiki-add-cross-link.tool.test.ts`

- Existing intra-wiki behavior unchanged.
- A `toPage` containing a `wikiId:` prefix is written through to the page body unchanged (tool does not validate or rewrite it).

### `ui/test/wiki-build-graph-data.test.ts`

- Update fixtures to namespaced ids; confirm filtering/edge-count/`derived_from`-exclusion behavior is unaffected by the id format change.
- Cross-wiki edge (`domainId` differs at each endpoint's node) is included when both domains are enabled, excluded when either is disabled.

### `ui/test/` (new, for the layout change)

- A focused unit test for the anchor-point computation (pure function extracted for testability, e.g. `computeDomainAnchors(domainIds, width, height)`) — single domain returns canvas center; multiple domains return distinct points.

### E2E (`e2e/tests/wiki-graph.spec.ts`, extends the existing file from issue #109's fix)

- Mock two wiki domains with a cross-wiki edge between them; assert the edge renders with the distinct cross-wiki styling (via `data-testid`/attribute selector, not CSS class).
- "Open in editor" from a graph node still opens the correct page (regression check for the id-stripping fix).

---

## 11. Files Changed

| File | Change |
| --- | --- |
| `lib/llm-wiki/src/internal/wikilinks.ts` | Add `parseExternalRef`; `resolveLinkTarget` callers route external refs through registry-aware resolution |
| `lib/llm-wiki/src/llm-wiki.ts` | `LlmWiki` stores `wikiId`; `LoadOptions`/`CreateOptions` gain `wikiId?`; `buildGraph()` gains `registry?` option, namespaces `GraphNode.id`, resolves external wikilinks and cross-wiki `contradictions` |
| `lib/llm-wiki/src/registry.ts` | `load()`/`create()` pass own id as `wikiId`; `lint()` populates `externalPages` |
| `lib/llm-wiki/src/internal/lint/checks.ts` | New `checkCrossWikiLinks` |
| `lib/llm-wiki/src/internal/lint/index.ts` | Register `checkCrossWikiLinks` in `runLint()` |
| `lib/llm-wiki/src/types.ts` | `LintCheckId` gains `'cross_wiki_links'`; `LintContext`-adjacent types gain `externalPages` |
| `api/src/routes/v1/wiki.route.ts` | `/graph` passes `registry` into `buildGraph()` |
| `api/src/agents/tools/wiki-add-cross-link.tool.ts` | Schema description updates only |
| `ui/src/pages/wiki/graph-view.tsx` | Per-domain anchor `forceX`/`forceY` replacing `forceCenter`; `forceCollide`; cross-wiki edge styling; "Open in editor" id-stripping fix |
| `ui/src/pages/wiki/build-graph-data.ts` | Anchor-point helper extracted for testability (if not colocated in `graph-view.tsx`) |
| `lib/llm-wiki/test/*.test.ts` | Coverage per §10 |
| `api/src/routes/v1/wiki.route.test.ts` (new) | Coverage per §10 |
| `api/src/agents/tools/wiki-add-cross-link.tool.test.ts` | Coverage per §10 |
| `ui/test/wiki-build-graph-data.test.ts` | Updated fixtures + cross-wiki edge coverage |
| `TODO_LIST.md` | Mark item complete per repo convention, once implemented |

---

## 12. Out of Scope

- Rewriting `resolveLinkTarget`/`buildGraph`'s single-wiki assumptions wholesale (rejected direction (a) from the issue).
- Validating cross-wiki reference targets at write time (`addCrossLink`) — deferred to lint, matching existing intra-wiki behavior.
- A new/separate agent tool for cross-wiki linking — the existing `wiki_add_cross_link` tool covers it via the `wikiId:pagePath` syntax.
- Separate mini-simulations per domain, or any layout family outside `d3-force` (hierarchy/sankey/chord) — the fix is composing the existing force simulation correctly, not switching layout engines.
- Any change to how `derived_from`/source nodes are handled — unaffected by cross-wiki edges.
