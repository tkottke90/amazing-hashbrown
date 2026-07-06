# `@tkottke90/llm-wiki`

Mechanical layer for building and maintaining an [LLM Wiki](../../docs/llm-wiki.md). Provides a deterministic, JSON-serializable "tool surface" that a future LLM inference layer can call without knowing the internal steps of each operation.

## The problem this solves

Most people who use AI assistants (like ChatGPT or Claude) start each conversation from scratch. You paste in some documents, ask a question, get an answer — and then that understanding disappears when the conversation ends. The next time you have a related question, the AI has to re-read the same documents and re-derive the same conclusions all over again. Nothing compounds.

The **LLM Wiki** pattern is a different approach: instead of answering questions directly from raw documents, the AI incrementally builds and maintains a persistent, interlinked collection of markdown files — a wiki. When you share a new document or article, the AI doesn't just answer a question about it; it reads the document, extracts what's important, and files it into the wiki — updating existing pages, creating new ones, noting where the new information agrees or conflicts with what's already there. The next time you ask a question, the AI reads the wiki (which already contains synthesized knowledge from everything you've ever shared) rather than starting from scratch.

The wiki is the memory. It gets richer with every source you add and every question you ask.

This library handles the **mechanical side** of maintaining that wiki — the bookkeeping that would otherwise be tedious and error-prone: creating the right file structure, writing pages with consistent formatting, keeping a table of contents current, tracking where information came from, detecting when a source has changed, checking for broken links, and building a map of how pages connect to each other. The AI focuses on understanding and synthesis; this library handles the filing.

## What this library does

- **Scaffolds** wiki directories with the standard structure (`entities/`, `concepts/`, `comparisons/`, `queries/`, `raw/`, plus `SCHEMA.md` / `index.md` / `log.md`).
- **Manages multiple wikis** via a JSON registry with deterministic scored routing between them.
- **Reads** wiki state in forms suited to LLM consumption: full orientation, keyword search, page listing, single-page reads.
- **Writes** wiki pages atomically: upserts content, keeps `index.md` current, appends to `log.md`, and surfaces soft warnings (too few links, unknown tags) without blocking.
- **Ingests** source material: hashes content, detects drift from prior ingests, writes immutable raw source files with provenance frontmatter.
- **Cross-links** pages: inserts `[[wikilink]]` entries under a `## Related Pages` section.
- **Lints** wiki health across 12 checks (broken links, orphans, stale pages, source drift, frontmatter validity, and more).
- **Builds a graph** of nodes and edges derived from wikilinks, contradictions, and source references — suitable for D3 force-graph and similar renderers.
- **Searches semantically** using hybrid BM25 + embedding ranking with a pluggable `EmbeddingProvider` — or keyword-only when no provider is configured.

## What this library does NOT do

- **No HTTP server or REST endpoints.** This is a pure library; routing and serving are the application's responsibility.
- **No LLM inference.** No AI calls, no LangChain. Raw source content is passed in as strings — fetching is the caller's responsibility.
- **No URL fetching.** `saveRawSource` and `ingestPrep` accept content strings; the caller retrieves the content.
- **No UI.** No rendering, no server-side HTML.

---

## Setup

### Install

The package is a private workspace dependency. From the repo root:

```sh
npm install
```

To depend on it from another workspace (e.g. `api`):

```json
// api/package.json
{
  "dependencies": {
    "@tkottke90/llm-wiki": "*"
  }
}
```

### Build

```sh
# From lib/llm-wiki/, or with --workspace from the repo root:
npm --workspace lib/llm-wiki run build
```

This compiles TypeScript to `dist/`. The `api` workspace resolves the package via the workspace symlink and can use `tsx` in dev without a prior build step.

### Environment

The library itself reads no environment variables — all configuration is passed explicitly at construction time. The app layer is responsible for resolving configuration (e.g. from `WIKI_ROOT`) and handing it in:

```ts
import { createWikiRegistry } from '@tkottke90/llm-wiki';
import { OpenAIEmbeddingProvider } from '@tkottke90/llm-wiki/providers';

const registry = await createWikiRegistry({
  wikiRoot: process.env.WIKI_ROOT ?? './config/kb',
  logger: myLogger, // optional; no-op if omitted
  embeddingProvider: new OpenAIEmbeddingProvider({ apiKey: process.env.OPENAI_API_KEY }),
});
```

The `logger` must implement `{ debug, info, warn, error }`. Any structured logger works; passing nothing is valid. The `embeddingProvider` is optional — omit it to use keyword-only search.

---

## Usage

All primary operations go through two classes:

- **`WikiRegistry`** — the multi-wiki handle. Owns `registry.json`, routes context to the right wiki, and manages wiki lifecycle.
- **`LlmWiki`** — the per-wiki tool surface. All read and write operations on a single wiki directory.

### Creating a registry and wiki

```ts
import { createWikiRegistry } from '@tkottke90/llm-wiki';

// Load an existing registry (or start empty if none exists)
const registry = await createWikiRegistry({ wikiRoot: './config/kb' });

// Scaffold a new wiki and register it
const wiki = await registry.create({
  id: 'homelab',
  name: 'Homelab',
  domain: 'infrastructure and services',
  tags: ['host', 'service', 'dns', 'proxy'],
  routingNotes: ['Docker, Authentik, NPM, MinIO, VPN -> homelab'],
});

// Or load an existing registered wiki by id
const wiki = await registry.load('homelab');
```

The wiki root directory and `registry.json` are created if absent. Each wiki gets its own subdirectory under the wiki root.

### Routing to the right wiki

When the correct wiki isn't known in advance, use `resolve` or the convenience wrapper:

```ts
// Returns { path, id, domain, score } | { ambiguous } | { noMatch }
const result = registry.resolve('question about Docker networking');

// Or resolve + load in one call (returns LlmWiki when unambiguous,
// or the ResolveResult if ambiguous/no-match)
const wiki = await registry.resolveOrLoad('Docker networking');
```

The scorer weights: id match +10, domain word hits +2 each, tag hits +3 each, routing-note trigger hits +8 each.

### Reading wiki state

```ts
// Load the wiki's current state — the typical first call in any LLM flow
const { schema, index, recentLog } = await wiki.orient();
// schema: string (SCHEMA.md contents)
// index:  string (index.md contents)
// recentLog: LogEntry[] — the last 30 log entries, parsed

// Keyword search over all content pages
const matches = await wiki.search(['unbound', 'dns']);
// → ['entities/dns-server.md', ...]

// List all pages as parsed WikiFile objects
const pages = await wiki.listPages();

// Read a single page
const page = await wiki.readPage('entities/dns-server.md');
// page.frontmatter, page.content (body only), page.sha, page.title, etc.
```

### Semantic search

`semanticSearch` supports three modes. All three return `RankedResult[]` — `{ path, score, title }` sorted by relevance.

```ts
// Hybrid mode (default): fuses BM25 keyword + embedding scores via RRF.
// Requires an embeddingProvider; falls back to keyword-only if none is set.
const results = await wiki.semanticSearch('domain name resolution');

// Explicit hybrid with options
const results = await wiki.semanticSearch('DNS resolver', {
  mode: 'hybrid', // 'hybrid' (default) | 'keyword' | 'semantic'
  limit: 5,       // default 10
});

// Keyword-only (BM25): no provider required — works on any wiki
const results = await wiki.semanticSearch('unbound DNS', { mode: 'keyword' });

// Semantic-only (cosine similarity against stored embeddings):
// requires embeddingProvider; throws if none is configured
const results = await wiki.semanticSearch('name resolution', { mode: 'semantic' });

// results[0] → { path: 'entities/dns-server.md', score: 0.94, title: 'DNS Server' }
```

Embeddings are persisted in `_embeddings.json` at the wiki root and updated incrementally — only pages whose body has changed since the last embed are re-processed. The index is invalidated and rebuilt automatically when the provider's model changes.

### Ingesting a source

```ts
// 1. Pre-flight: hash + drift check + existing page lookup
const prep = await wiki.ingestPrep({
  content: articleMarkdown,
  url: 'https://example.com/article',
  keywords: ['dns', 'unbound'],
});
// prep.sha256, prep.isNew, prep.drift, prep.existingPages, prep.suggestedRawPath

// 2. Save the immutable raw source
await wiki.saveRawSource({
  content: articleMarkdown,
  sourceUrl: 'https://example.com/article',
  sha256: prep.sha256,
  // path: prep.suggestedRawPath  // optional; defaults to suggestedRawPath
});

// 3. Commit synthesized wiki pages (one or more)
const result = await wiki.commitPage({
  type: 'entity', // 'entity' | 'concept' | 'comparison' | 'query' | 'summary'
  title: 'DNS Server',
  tags: ['dns', 'service'],
  sources: [prep.suggestedRawPath],
  summary: 'Runs unbound for local DNS resolution',
  body: '## Overview\n\nThe DNS server...\n\n## Related Pages\n- [[proxy]]\n- [[host]]',
  confidence: 'high',
});
// result.path, result.created (true = new page), result.warnings[]

// 4. Add cross-links between related pages
await wiki.addCrossLink({ fromPage: 'entities/proxy.md', toPage: 'entities/dns-server.md' });
```

`commitPage` handles everything: writing the file, updating `index.md`, and appending to `log.md`. Malformed input (missing title, missing required frontmatter) throws. Soft violations (fewer than 2 wikilinks, unknown tag) return `warnings` but still write the page.

### Linting

```ts
// Run all 12 health checks
const report = await wiki.lint();
// report.ok — false if any error-severity finding exists
// report.checks — LintFinding[]

// Lint through the registry (enables the registry_sync check)
const report = await registry.lint('homelab');

// Filter by severity
const errors = report.checks.filter((c) => c.severity === 'error');
const warnings = report.checks.filter((c) => c.severity === 'warn');
```

The 12 checks: `broken_links`, `orphans`, `frontmatter`, `index`, `page_size`, `tag_audit`, `source_drift`, `log_rotation`, `stale`, `quality`, `contradictions`, `registry_sync`.

### Building a graph

Returns a node/edge structure ready for D3 `forceSimulation` or similar:

```ts
const graph = await wiki.buildGraph();
// graph.nodes — GraphNode[]  (id, title, type, tags, confidence?, contested?)
// graph.edges — GraphEdge[]  (source, target, type)

// Edge types:
// 'references'  — [[wikilink]] in page body pointing to another page
// 'contradicts' — contradictions frontmatter field
// 'derived_from'— sources frontmatter field (opt-in)

// Include raw source files as nodes + derived_from edges:
const graph = await wiki.buildGraph({ includeSources: true });
```

Node `id` values are page stems (e.g. `"entities/dns-server"`), which double as route keys for page navigation. Duplicate edges are suppressed. Unresolvable wikilinks and contradiction targets produce no edges.

For D3, extend nodes with `SimulationNodeDatum` and set the id accessor:

```ts
import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3';

type D3Node = GraphNode & SimulationNodeDatum;
type D3Edge = SimulationLinkDatum<D3Node> & { type: GraphEdge['type'] };

simulation.nodes(graph.nodes as D3Node[]).force(
  'link',
  forceLink<D3Node, D3Edge>(graph.edges as D3Edge[]).id((d) => d.id),
);
```

Tags are available on each node (`node.tags`) and work naturally as a color encoding dimension without needing tag-level nodes or edges.

### Logging a manual entry

For actions that don't go through `commitPage` (e.g. queries, sessions):

```ts
await wiki.log({ action: 'query', subject: 'DNS failover behaviour' });
await wiki.log({ action: 'lint', subject: 'weekly health check', files: [] });
```

### Embedding providers

Import from the `@tkottke90/llm-wiki/providers` sub-path. Pass a provider instance to `LlmWiki.create()`, `LlmWiki.load()`, or `createWikiRegistry()`.

```ts
import {
  NullEmbeddingProvider,
  AnthropicEmbeddingProvider,
  OpenAIEmbeddingProvider,
  OllamaEmbeddingProvider,
} from '@tkottke90/llm-wiki/providers';
```

| Class | Backend | Required env / option |
|---|---|---|
| `NullEmbeddingProvider` | none (zero vectors) | — |
| `AnthropicEmbeddingProvider` | Voyage AI (`voyageai` package) | `VOYAGE_API_KEY` or `{ apiKey }` |
| `OpenAIEmbeddingProvider` | OpenAI (`openai` package) | `OPENAI_API_KEY` or `{ apiKey }` |
| `OllamaEmbeddingProvider` | Ollama local server | `{ baseUrl?, model? }` |

```ts
// Null — useful in tests and CI
new NullEmbeddingProvider()          // 1536-dim zero vectors
new NullEmbeddingProvider(512)       // custom dimension

// Anthropic / Voyage AI (default model: voyage-3)
new AnthropicEmbeddingProvider()
new AnthropicEmbeddingProvider({ apiKey: '...', model: 'voyage-3-lite' })

// OpenAI (default model: text-embedding-3-small)
new OpenAIEmbeddingProvider()
new OpenAIEmbeddingProvider({ apiKey: '...', model: 'text-embedding-3-large' })

// Ollama (default: http://localhost:11434/v1, model: nomic-embed-text)
new OllamaEmbeddingProvider()
new OllamaEmbeddingProvider({ baseUrl: 'http://my-host:11434/v1', model: 'mxbai-embed-large' })
```

You can also implement `EmbeddingProvider` directly for any other backend:

```ts
import type { EmbeddingProvider } from '@tkottke90/llm-wiki/providers';

class MyProvider implements EmbeddingProvider {
  readonly model = 'my-model-v1';
  async embed(texts: string[]): Promise<number[][]> { /* ... */ }
}
```

---

## File layout

```
<wikiRoot>/
  registry.json             Multi-wiki index (JSON, managed by WikiRegistry)
  <wiki-id>/
    SCHEMA.md               Tag taxonomy and page conventions
    index.md                Content catalog — updated on every commitPage
    log.md                  Append-only activity log
    _embeddings.json        Persisted embedding vectors (written when a provider is set)
    entities/               Entity pages (*.md)
    concepts/               Concept pages
    comparisons/            Comparison pages
    queries/                Query/answer pages
    raw/
      articles/             Immutable ingested source documents
```

Pages in `entities/`, `concepts/`, `comparisons/`, and `queries/` are the linkable content nodes. `raw/` files are immutable sources — never modified after `saveRawSource` writes them.

---

## Running tests

```sh
npm --workspace lib/llm-wiki test
```

89 tests covering unit functions (wikilinks, routing, nav, sha, paths, frontmatter, lint checks, BM25 scorer, cosine similarity, embedding providers) and class integration (create → orient → ingest → commit → cross-link → lint → buildGraph → registry routing → semanticSearch).
