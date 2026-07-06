# LLM Wiki — Repository Layer Design

**Date:** 2026-07-04
**Status:** Approved (design)
**Related:** [`docs/llm-wiki.md`](../llm-wiki.md) (the pattern), source skill at
`~/.hermes-automations/skills/llm-wiki/`

## Purpose

Codify the mechanical parts of the `llm-wiki` skill as a reusable TypeScript
library so that a future LLM-judgement layer can operate an LLM Wiki by calling
deterministic "tools" without knowing the internal steps of each operation.

The skill today is a hybrid: six Python scripts that do deterministic bookkeeping
(routing, orient, init, ingest-prep, nav-update, lint) plus markdown workflows a
coding agent executes with judgement. This project ports **only the deterministic
islands** into code the LLM will later call.

The guiding principle: _build the known mechanical patterns so the inference layer
doesn't need to know the exact steps — it just leverages the mechanical system to
work on the wiki._

## Scope

**In scope**

- A standalone library workspace implementing the mechanical wiki operations.
- Multi-wiki support with a JSON registry and deterministic scored routing.
- A coarse, JSON-serializable "tool surface" (methods) ready to be wrapped as LLM
  tools later.
- Full unit + integration test coverage.

**Out of scope** (each a later spec)

- REST/HTTP endpoints.
- Any live LLM / LangChain wiring.
- Tool descriptions, prompt engineering, or an operator guide for the LLM.
- URL fetching / web extraction (raw source _content_ is passed in as a string).
- UI.

## Key Decisions

| Topic            | Decision                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Wiki identity    | Multi-wiki + deterministic scored routing (port of `wiki-route.py`).                                                                 |
| Storage          | Config-managed wiki root (default `./config/kb`, gitignored in dev).                                                                 |
| Registry         | `registry.json` loaded/validated at boot, maintained in memory + persisted.                                                          |
| Code shape       | Single `LlmWiki` class of coarse methods + separate `WikiRegistry`, both thin facades over focused `internal/` modules (Approach B). |
| Packaging        | Its own npm workspace `@tkottke90/llm-wiki` under `lib/`, framework-agnostic.                                                        |
| Logging          | Optional injected logger interface; no-op if omitted.                                                                                |
| Write invariants | Warn-on-write: hard errors block, soft violations return warnings; `lint()` is the authoritative health check.                       |
| Inference dip    | Code + types only. Clean structured outputs; no prompting/tool metadata this spec.                                                   |

## Section 1 — Package layout

The mechanical engine is framework-agnostic, so it lives in its own workspace and
cannot reach into Express, `config-manager`, or the request logger.

```
lib/llm-wiki/
  package.json          name: "@tkottke90/llm-wiki"; own build (tsc) + test (mocha)
  tsconfig.json         extends root tsconfig.base
  src/
    index.ts            Barrel: createWikiRegistry, LlmWiki, WikiRegistry, public types
    llm-wiki.ts         LlmWiki class — coarse tool surface (facade)
    registry.ts         WikiRegistry — load/persist registry.json, scored routing
    types.ts            Public types (WikiFile, Wiki, results, lint report,
                        EmbeddingProvider, RankedResult, SemanticSearchOptions)
    internal/
      frontmatter.ts    parse/serialize via gray-matter; required-field + tag checks
      wikilinks.ts      extract [[links]], normalize, resolve targets, backlink scan
      paths.ts          slugging, suggested raw/page paths, subdir constants
      templates.ts      SCHEMA.md / index.md / log.md skeletons
      sha.ts            body-only sha256 + drift compare
      routing.ts        pure scoring fn (port of score_wiki)
      embedding-index.ts  manage _embeddings.json (load/save/upsert/drift check);
                          cosineSimilarity helper
      bm25.ts           pure BM25 scorer (k1=1.5, b=0.75); no external deps
      lint/
        index.ts        runLint(ctx, opts) → LintReport
        checks.ts       the individual check functions
    providers/
      index.ts          Barrel for @tkottke90/llm-wiki/providers sub-path export
      null.ts           NullEmbeddingProvider — zero vectors, test/dev use
      anthropic.ts      AnthropicEmbeddingProvider — Voyage AI via voyageai package
      openai.ts         OpenAIEmbeddingProvider — OpenAI embeddings API
      ollama.ts         OllamaEmbeddingProvider — Ollama local server (OpenAI compat)
  test/                 Mocha + Chai, temp-dir wiki fixtures
```

- Root [`package.json`](../../package.json) `workspaces` becomes `["api", "ui", "lib/*"]`.
- `api` adds `"@tkottke90/llm-wiki": "*"` as a dependency.
- Library dependencies: `gray-matter`, `zod`, `openai`, `voyageai`, `@anthropic-ai/sdk`.
- `internal/` modules are pure and one-way: they never import the `LlmWiki` /
  `WikiRegistry` classes.
- `providers/` is exported at the `@tkottke90/llm-wiki/providers` sub-path so
  consumers can import providers without pulling in the full library surface.

**Setup interface change.** The library reads no env/config itself. It's
constructed with explicit config:

```ts
createWikiRegistry({ wikiRoot: string, logger?: Logger }): Promise<WikiRegistry>
// Logger = a tiny injected interface { debug, info, warn, error }, optional (no-op if omitted)
```

The `api` side stays thin: `env.ts` resolves `wikiRoot` (add `wikiRoot` to
`AppConfigSchema`, default `./config/kb`) from `config-manager`, and a small
`api/src/services/wiki.ts` calls `createWikiRegistry({ wikiRoot, logger })` and
re-exports for the rest of the API. The app owns _configuration_; the lib owns
_mechanics_.

**Build/dev.** TypeScript project references so root `npm run build` builds the lib
before `api`. The lib's `exports` map to built `dist/` for production; `api`'s `tsx
watch` resolves the workspace in dev. Exact dev-resolution wiring finalized in the
implementation plan.

## Section 2 — The `LlmWiki` tool surface

`LlmWiki` is one instance bound to one wiki directory. Every method is a
deterministic tool that hides a full mechanical sequence, takes plain inputs, and
returns structured, JSON-serializable results. Content is always passed in as
strings (no fetching).

**Factories**

- `static async create({ path, name, domain, tags, logger?, embeddingProvider? }): Promise<LlmWiki>`
  — scaffolds dirs (`raw/ entities/ concepts/ comparisons/ queries/`) and writes
  `SCHEMA.md` / `index.md` / `log.md` from templates with `domain` filled in.
  Tag-taxonomy customization and seed pages stay with the LLM. Ports `wiki-init.py`.
- `static async load(path, { logger?, embeddingProvider? }): Promise<LlmWiki>` — loads
  an existing wiki, parses `SCHEMA.md` (taxonomy + required fields) into memory.

**Read / orient tools**

- `orient(): Promise<OrientResult>` — `{ schema, index, recentLog[] }` (last N log
  entries). The single call the LLM makes to load current state. Ports `wiki-orient.py`.
- `search(terms: string[]): Promise<string[]>` — matching page rel-paths (grep
  replacement, no provider required).
- `semanticSearch(query: string, opts?: SemanticSearchOptions): Promise<RankedResult[]>` —
  ranked search across all content pages. Three modes:
  - `'keyword'`: BM25 scorer over page text; no provider required.
  - `'semantic'`: cosine similarity against stored embeddings; requires `embeddingProvider`.
  - `'hybrid'` (default): Reciprocal Rank Fusion (k=60) over both rank lists.
  Embeddings are persisted in `_embeddings.json` at the wiki root and updated
  incrementally — only pages whose body sha differs from the stored sha are
  re-embedded. The index is invalidated and rebuilt in full when the provider's
  `model` string changes.
- `listPages(): Promise<WikiFile[]>` / `readPage(relPath): Promise<WikiFile>` — typed reads.

**Ingest tools**

- `ingestPrep({ content, url?, filename?, keywords? }): Promise<IngestPrep>` —
  `{ sha256, isNew, drift, existingRaw, storedSha256, existingPages[], suggestedRawPath }`.
  Body-only sha, drift vs prior ingest, existing-page lookup. Ports `wiki-ingest-prep.py`.
- `saveRawSource({ content, sourceUrl, sha256, path? }): Promise<{ path }>` — writes
  the immutable `raw/` file with frontmatter. On drift, writes a new dated file
  rather than overwriting raw.
- `commitPage(page: PageInput): Promise<CommitResult>` — **upsert** of one wiki
  page: serializes frontmatter (`gray-matter`), bumps `updated`, merges `sources`,
  writes the file, updates `index.md`, appends a `log.md` entry, and — if an
  `embeddingProvider` is configured — embeds the page body and upserts
  `_embeddings.json`. The "LLM needn't know the steps" tool. Returns `{ path,
  created, warnings[] }`. Warn-on-write: malformed frontmatter / missing required
  fields → rejected error result; <2 wikilinks or tag-not-in-taxonomy → `warnings`.
  Folds in `wiki-nav-update.py`.
- `addCrossLink({ fromPage, toPage }): Promise<CommitResult>` — inserts a
  `[[wikilink]]` under the target's "Related Pages" and bumps `updated` (the
  mechanical half of the backlink sweep).

**Bookkeeping / health**

- `log({ action, subject, files? }): Promise<void>` — append a formatted
  `## [date] action | subject` entry (for updates/queries that don't go through
  `commitPage`).
- `lint(): Promise<LintReport>` — runs all applicable checks → structured report
  grouped by severity. Ports `wiki-lint.py`.

**Typical LLM flows** (illustrative; the LLM layer is a later spec)

- Ingest: `orient` → `ingestPrep` → `saveRawSource` → _(judgement)_ → `commitPage`×N
  → `addCrossLink`×N.
- Query: `orient` / `semanticSearch` → `readPage` → _(judgement)_ → optional
  `commitPage(type: query)` + `log`.

## Section 3 — `WikiRegistry` + routing

`WikiRegistry` is the top-level, multi-wiki handle, constructed once with the app
config; it owns `registry.json`.

**Factory** — `createWikiRegistry({ wikiRoot, logger? })` reads
`<wikiRoot>/registry.json` into memory (validated with a `zod` schema); if absent,
starts an empty registry.

**Registry shape (`registry.json`)** — validated on load:

```jsonc
{
  "version": 1,
  "wikis": [
    {
      "id": "homelab",
      "path": "homelab", // rel to wikiRoot (or absolute)
      "domain": "infrastructure & services",
      "tags": ["host", "service", "dns", "proxy"],
      "status": "active",
    },
  ],
  "routingNotes": [
    "Authentik, NPM, MinIO, DNS, VPN, reverse proxy, Docker, homelab servers -> homelab",
    "workouts, training, strength, cardio, fitness programming -> health-fitness",
  ],
}
```

`routingNotes` is a **top-level** flat list, each line `"<triggers> -> <wiki-id>"`.
Routing notes are LLM-authored judgement — the mechanical layer only stores,
parses, and scores them, and offers a write method to persist what the LLM decides.

**Methods**

- `resolve(context: string): ResolveResult` — the routing tool. Runs the
  deterministic scorer (`internal/routing.ts`, port of `score_wiki`) over every
  active wiki. Scoring: `name` +10, domain words +2, tags +3, routing-note trigger
  hits +8. Returns one of `{ path, id, domain, score }` ·
  `{ ambiguous: true, candidates[] }` · `{ noMatch: true, available[] }`. Pure
  function of registry + context.
- `list(): WikiEntry[]` — registered wikis (active by default).
- `load(id): Promise<LlmWiki>` — resolves the entry's path and returns
  `LlmWiki.load(path)`.
- `create({ id, name, domain, tags, routingNotes? }): Promise<LlmWiki>` — calls
  `LlmWiki.create(...)`, appends the entry, persists `registry.json`.
- `saveRoutingNotes(notes: string[]): Promise<void>` — persists LLM-maintained
  routing notes.
- `resolveOrLoad(context)` — convenience: `resolve` then `load` when unambiguous.

**Persistence.** Registry is kept in memory after boot; mutating methods persist
back to `registry.json` atomically (write-temp-then-rename). The `registry_sync`
lint check compares on-disk wiki dirs against registry entries and flags drift.

Clean split: **`WikiRegistry` = which wiki + registry bookkeeping; `LlmWiki` = work
inside one wiki.** The `api` holds exactly one `WikiRegistry`, built from
`env.wikiRoot`.

## Section 4 — Data model & types

All types are JSON-serializable so the future inference layer can consume them
directly. Starting point is the existing `api/src/types/wiki.d.ts`
(`WikiFile` / `Wiki`), moved into the lib as `src/types.ts`.

```ts
interface PageFrontmatter {
  title: string;
  created: string; // ISO date string
  updated: string; // ISO date string
  type: 'entity' | 'concept' | 'comparison' | 'query' | 'summary' | 'index' | 'log';
  tags: string[];
  sources: string[]; // rel paths into raw/
  confidence?: 'high' | 'medium' | 'low';
  contested?: boolean;
  contradictions?: string[];
}

interface WikiFile {
  filename: string; // rel to wiki root
  title: string;
  type: PageFrontmatter['type'];
  frontmatter: PageFrontmatter;
  content: string; // body only (no frontmatter)
  sha: string;
  created: Date;
  lastModified: Date;
}

interface PageInput {
  type: PageFrontmatter['type'];
  title: string;
  tags: string[];
  sources: string[];
  body: string;
  confidence?: PageFrontmatter['confidence'];
  contested?: boolean;
  contradictions?: string[];
  relPath?: string; // optional → derived from title/type
}

interface CommitResult {
  path: string;
  created: boolean;
  warnings: Warning[];
}
interface Warning {
  code: 'few-wikilinks' | 'unknown-tag' | 'stale' | string;
  message: string;
}

interface IngestPrep {
  sha256: string;
  isNew: boolean;
  drift: boolean;
  existingRaw: string | null;
  storedSha256: string | null;
  existingPages: string[];
  suggestedRawPath: string;
}

interface OrientResult {
  schema: string;
  index: string;
  recentLog: LogEntry[];
}
interface LogEntry {
  date: string;
  action: string;
  subject: string;
  raw: string;
}

// Registry entry (as stored in registry.json, minus routingNotes which are top-level)
interface WikiEntry {
  id: string;
  path: string; // rel to wikiRoot or absolute
  domain: string;
  tags: string[];
  status: 'active' | 'archived';
}

type ResolveResult =
  | { path: string; id: string; domain: string; score: number }
  | { ambiguous: true; candidates: { id: string; path: string }[] }
  | { noMatch: true; available: string[] };

interface LintReport {
  ok: boolean;
  checks: LintFinding[];
}
interface LintFinding {
  check: LintCheckId;
  severity: 'error' | 'warn' | 'info';
  page?: string;
  message: string;
}
type LintCheckId =
  | 'orphans'
  | 'broken_links'
  | 'index'
  | 'frontmatter'
  | 'page_size'
  | 'tag_audit'
  | 'source_drift'
  | 'log_rotation'
  | 'stale'
  | 'quality'
  | 'contradictions'
  | 'registry_sync';
```

// Semantic search
interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

interface RankedResult {
  path: string;
  score: number;
  title: string;
}

interface SemanticSearchOptions {
  limit?: number;                              // default 10
  mode?: 'semantic' | 'keyword' | 'hybrid';   // default 'hybrid'
}
```

`Warning` (soft, from writes) and `LintFinding` (authoritative, from lint) share
vocabulary but stay distinct types.

## Section 5 — Lint engine & testing

**Lint engine** (`internal/lint/`) — a faithful TS port of `wiki-lint.py`,
decomposed:

- `checks.ts` exports each check as a pure function `(ctx: LintContext) =>
LintFinding[]`, where `LintContext` is a pre-loaded snapshot (all pages parsed
  once, index parsed, log line count, registry entries). Loading once and passing a
  shared context avoids re-reading files per check.
- `index.ts` exports `runLint(ctx, { only?: LintCheckId[] })` — runs all checks (or
  a subset), concatenates findings, sets `ok = no error-severity findings`.
- `LlmWiki.lint()` builds the context from its own wiki; `registry_sync` needs
  registry data, so `WikiRegistry` injects itself (or the entry list) when linting
  through it.
- Severity mapping: `broken_links` / malformed-frontmatter → `error`; `orphans` /
  `source_drift` / `contested` → `warn`; `stale` / low-confidence / oversized →
  `info`.

The twelve checks port straight across: orphans, broken_links, index completeness,
frontmatter validation, page_size (>200 lines), tag_audit, source_drift (sha
mismatch), log_rotation (>500 entries), stale (>90d), quality
(low-confidence/contested), contradictions, registry_sync.

**Testing** (`lib/llm-wiki/test/`, Mocha + Chai to match `api`):

- **`internal/` units** — pure-function tests, no fs: frontmatter round-trip,
  wikilink extraction/normalization, routing scorer (feed a registry + context;
  assert winner / ambiguous / no_match), sha/drift, each lint check against small
  in-memory page sets.
- **Class integration** — build a throwaway wiki in an OS temp dir (`fs.mkdtemp`),
  exercise `create → orient → ingestPrep → saveRawSource → commitPage →
addCrossLink → lint`, assert on-disk files + returned structures, tear the temp
  dir down after. Fixtures: a seeded multi-page wiki (for lint/search/routing) and
  an empty one (for create/scaffold).
- **Registry** — temp `wikiRoot` with a `registry.json`; assert `resolve` /
  `create` / `saveRoutingNotes` behavior and that persistence round-trips through
  the zod schema.

Root `npm test` picks up the new workspace once it has a `"test": "mocha"` script.

## Follow-on specs

1. **Inference layer** — wrap the coarse methods as LLM tools (descriptions, input
   schemas), prompt design, LangChain/Ollama wiring.
2. **HTTP layer** — `/api/v1/wiki/*` routes over `WikiRegistry` / `LlmWiki`.
3. **UI** — browse/query surface.
