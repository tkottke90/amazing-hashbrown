# App Wiki — Application Documentation Design

**Date:** 2026-08-08  
**Status:** Draft  
**Related:** [`docs/app-wiki/`](../../app-wiki/), [`lib/assets/`](../../../lib/assets/), [`lib/llm-wiki/`](../../../lib/llm-wiki/), [`TODO_LIST.md`](../../../TODO_LIST.md)

## Purpose

Repurpose the `self` wiki domain — originally scaffolded to let the agent build a sense of identity through conversation — as a read-only application documentation wiki. The new wiki (`app-docs`) is generated from curated developer-authored docs, stored in the repo, and shipped with the application. At runtime the agent can query it to answer user questions about how the application works (e.g. "how do I configure MCP?", "what providers are supported?", "how does the wiki work?").

The `self` domain is retired from the default scaffolding. Existing installs that already have a `self` wiki on disk are left untouched.

---

## Background

### The `self` wiki — what it was

On first boot, `bootKnowledgeBase()` in `api/src/services/wiki.ts` scaffolds two wiki domains: `user` and `self`. The `user` wiki holds personal context about the person running the app. The `self` wiki was intended to hold the agent's own reasoning, values, and reflection — a "sense of self" built incrementally through the AfterAgent pipeline.

In practice the application does not have the design infrastructure to support genuine agent self-reflection in a meaningful way. The `self` domain accumulates thin conversation extracts with no coherent update or curation strategy.

### The gap this fills

The agent has no structured knowledge of the application it runs inside. When a user asks a configuration question, the agent can only answer from training-time knowledge of the repo (which is stale and incomplete). A curated application documentation wiki gives the agent a stable, authoritative, queryable domain specifically about this app.

### Three-phase content pipeline

The design separates content authorship from wiki mechanics:

```
1. Code/feature changes
        │
        ▼
2. Developer authors/updates markdown files in docs/app-wiki/
   (editorial gate — humans control quality before any generation runs)
        │
        ▼
3. Generation script reads docs/app-wiki/, synthesises wiki pages via LLM,
   writes output to lib/assets/app-wiki/
   (run as part of the release process; output is committed and bundled into the Docker image)
```

This keeps the developer in the loop for content quality while automating the mechanical transformation into wiki format.

---

## Scope

**In scope (this spec):**

- New `'readOnly'` status on `WikiEntry` in `lib/llm-wiki`
- Registry and write-service enforcement of read-only status
- Retire `self` from `DEFAULT_DOMAINS` in `api/src/services/wiki.ts`
- `docs/app-wiki/` — developer-authored source markdown (the editorial gate before generation)
- `lib/assets/app-wiki/` — generated wiki artifact bundled into the Docker image; `SCHEMA.md` pre-committed here as a static file
- `bin/wiki-generate.ts` — generation script that reads `docs/app-wiki/` and writes to `lib/assets/app-wiki/`
- `app-docs` domain boot entry with `status: 'readOnly'`

**Out of scope:**

- Changes to the `user` wiki or AfterAgent pipeline
- Any UI changes — the existing wiki graph/viewer works unchanged
- Automated CI trigger for generation (manual invocation at release time initially)
- The agent proactively suggesting documentation to users (future)

---

## Architecture

```
docs/app-wiki/*.md          (developer-authored source docs — editorial gate)
        │
        ▼  bin/wiki-generate.ts  (run manually at release)
        │  uses: inference-adapter, @tkottke90/llm-wiki
        │
        ▼
lib/assets/app-wiki/        ← committed to repo, bundled into Docker image
  SCHEMA.md                 ← pre-committed static file (not LLM-generated)
  index.md
  log.md
  _embeddings.json
  concepts/
  entities/
  queries/
  raw/articles/
        │
        ▼  Docker build — copies lib/assets/app-wiki/ into image
        │
        ▼  bootKnowledgeBase() at startup
        │  registers lib/assets/app-wiki/ as domain 'app-docs', status: readOnly
        │
        ▼
WikiRegistry (runtime)
  domain: app-docs, status: readOnly
  domain: user,     status: active
        │
        ├── wiki_search / wiki_orient / wiki_read_page   (all domains)
        └── wiki_create_page / wiki_update_page          (active only — blocked for readOnly)
```

---

## Component Design

### 1. `lib/llm-wiki` — `'readOnly'` status

**`src/types.ts`**

Extend the `WikiEntry.status` union:

```ts
// before
status: 'active' | 'archived';

// after
status: 'active' | 'archived' | 'readOnly';
```

**`src/registry.ts`**

Update the Zod schema that parses `registry.json`:

```ts
status: z.enum(['active', 'archived', 'readOnly']).default('active'),
```

Update `list(includeArchived?)` so `'readOnly'` wikis appear in the default (non-archived) listing — they are usable for reading and should be visible to the agent:

```ts
// before
this.data.wikis.filter((w) => w.status === 'active');

// after
this.data.wikis.filter((w) => w.status === 'active' || w.status === 'readOnly');
```

`list(true)` already returns all entries; no change needed there.

### 2. `api/src/services/wiki-write.ts` — read-only guard

Both `createWikiPage` and `updateWikiPage` add a status check immediately after the registry resolves and before any wiki is loaded. This is the single enforcement point — tools do not need their own checks.

New result variants added to each function's return type:

```ts
| { status: 'read_only'; wikiId: string }
```

Guard implementation (same pattern in both functions):

```ts
const entry = reg.list(true).find((w) => w.id === wikiId);
if (entry?.status === 'readOnly') {
  return { status: 'read_only', wikiId };
}
```

Tool files (`wiki-create-page.tool.ts`, `wiki-update-page.tool.ts`) add a case for the new result:

```ts
case 'read_only':
  return `Wiki "${result.wikiId}" is read-only and cannot be written to directly.`;
```

### 3. `api/src/services/wiki.ts` — domain changes

Remove `self` from `DEFAULT_DOMAINS`. Add `app-docs` with `status: 'readOnly'` and a path pointing to the committed wiki directory:

```ts
const DEFAULT_DOMAINS: CreateWikiInput[] = [
  {
    id: 'user',
    name: 'User',
    domain: 'user',
    tags: [],
    routingNotes: ['user preferences, personal context, and biography -> user'],
  },
  {
    id: 'app-docs',
    name: 'Application Documentation',
    domain: 'application configuration, features, providers, wiki, and how-to guides',
    tags: ['documentation', 'application'],
    status: 'readOnly',
    path: path.resolve(process.cwd(), './lib/assets/app-wiki'),
    routingNotes: [
      'how to configure the application -> app-docs',
      'how to use a feature -> app-docs',
      'application providers, settings, MCP, wiki, skills -> app-docs',
    ],
  },
];
```

`bootKnowledgeBase()` registers `app-docs` via `registry.register()` (not `registry.create()`) pointing to `lib/assets/app-wiki/`. In a Docker deployment this path resolves to the bundled copy inside the image. When the directory does not exist (e.g. a dev environment where `wiki:generate` has not been run yet), the boot step logs a warning and skips registration rather than failing — the agent simply has no `app-docs` domain in that case.

Existing installs with a `self` wiki on disk are unaffected — `self` is removed from `DEFAULT_DOMAINS` but the data stays wherever it was scaffolded.

### 4. `docs/app-wiki/` — developer-authored source docs

Plain markdown files written and maintained by the developer. These are the editorial gate: the generation script only processes what exists here, so content quality is controlled before any LLM transformation runs.

Initial source documents mirror the existing `docs/App-Docs/` content (configuration, providers, evaluations) plus user-facing feature guides. Files here are **not** wiki-format pages — they are free-form markdown that the generation script reads as raw source material.

### 5. `lib/assets/` — generated wiki and static assets

`lib/assets/` is a plain directory (no `package.json`) tracked in git and bundled into the Docker image. For this feature its content is:

```
lib/assets/
  app-wiki/
    SCHEMA.md           ← pre-committed static file; defines the wiki's taxonomy
    index.md            ← generated
    log.md              ← generated
    _embeddings.json    ← generated
    concepts/           ← generated
    entities/           ← generated
    queries/            ← generated
    raw/articles/       ← generated (provenance copies of source docs)
```

`SCHEMA.md` is a static file committed directly — it is not LLM-generated. It defines the taxonomy for user-facing documentation:

**Tags:** `configuration`, `provider`, `wiki`, `mcp`, `skills`, `evaluations`, `shell`, `ui`, `setup`, `how-to`, `reference`

**Page types used:**

- `concept` — how a feature works (e.g. "How the Wiki Works", "AfterAgent Pipeline")
- `entity` — a specific configurable thing (e.g. "Ollama Provider", "MCP Server")
- `query` — captured how-to Q&A (e.g. "How do I configure MCP?", "How do I add a provider?")

**Out of scope for this wiki:** API internals, source code details, developer-facing architecture. All content must be understandable without reading source code.

The generated files (`index.md`, `log.md`, page directories, `_embeddings.json`) are committed after each generation run so the Docker image always ships a ready-to-use wiki with no generation step required at container startup.

### 6. `bin/wiki-generate.ts` — generation script

A standalone script invoked manually as part of the release process. It is not integrated into the dev watch loop.

**Inputs:** source markdown files from `docs/app-wiki/`.

**Output:** `lib/assets/app-wiki/` — the generated wiki bundled into the Docker image.

**Algorithm:**

1. Load (or scaffold) the `app-docs` wiki at `lib/assets/app-wiki/` using `LlmWiki.create()` / `LlmWiki.load()`. `SCHEMA.md` is already present as a static committed file; the script does not overwrite it.
2. For each source document in `docs/app-wiki/`:
   a. Call `wiki.ingestPrep({ content })` — detect whether the source has changed since the last run (SHA drift).
   b. Skip if SHA is unchanged (incremental — only re-generates pages for changed sources).
   c. Call `wiki.saveRawSource()` to write the immutable provenance copy.
   d. Call the LLM (via `inference-adapter`) with the source content and a generation prompt, producing one or more `PageInput` objects.
   e. Call `wiki.commitPage()` for each generated page, with `sources[]` pointing to the raw source path.
3. Run `wiki.lint()` and print findings. Fail with a non-zero exit if any `error`-severity lint findings exist.

**Incremental behaviour:** Because `saveRawSource()` hashes source content and `ingestPrep()` detects drift, unchanged sources are skipped. Only documents that changed since the last generation run produce new LLM calls. A full regeneration can be forced with a `--force` flag.

**New npm script in root `package.json`:**

```json
"wiki:generate": "tsx bin/wiki-generate.ts"
```

---

## Error Handling

| Scenario                                      | Behaviour                                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Agent calls `wiki_create_page` on `app-docs`  | Returns `'read_only'` result; tool reports wiki is read-only                                                    |
| Agent calls `wiki_update_page` on `app-docs`  | Same as above                                                                                                   |
| `lib/assets/app-wiki/` does not exist at boot | Boot logs a warning, skips `app-docs` registration; agent has no `app-docs` domain until `wiki:generate` is run |
| `wiki:generate` fails mid-run                 | Partial wiki on disk; re-run is safe (incremental by default)                                                   |
| Generation LLM call fails for one source      | Script logs the error, continues with remaining sources, exits non-zero                                         |
| `self` wiki still on disk                     | Registry continues to show it as-is; user controls its status                                                   |

---

## References

- `lib/llm-wiki/src/types.ts` — `WikiEntry`, `PageFrontmatter`
- `lib/llm-wiki/src/registry.ts` — `list()`, Zod schema, `register()`
- `api/src/services/wiki-write.ts` — `createWikiPage`, `updateWikiPage`
- `api/src/services/wiki.ts` — `DEFAULT_DOMAINS`, `bootKnowledgeBase()`
- `api/src/agents/tools/wiki-create-page.tool.ts` — write tool to update
- `api/src/agents/tools/wiki-update-page.tool.ts` — write tool to update
- `docs/app-wiki/` — developer-authored source docs (this feature)
- `lib/assets/app-wiki/` — generated wiki artifact bundled into Docker image (this feature)
- `bin/wiki-generate.ts` — generation script (this feature)
