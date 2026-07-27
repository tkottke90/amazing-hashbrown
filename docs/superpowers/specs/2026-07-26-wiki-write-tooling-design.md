# Wiki Write Tooling — Design

**Date:** 2026-07-26
**Status:** Approved (design)
**Related:** [`docs/Design/2026-07-04-llm-wiki-repository-layer-design.md`](../../Design/2026-07-04-llm-wiki-repository-layer-design.md) (the underlying `@tkottke90/llm-wiki` library), [`docs/Design/2026-07-17-afteragent-middleware-design.md`](../../Design/2026-07-17-afteragent-middleware-design.md), [`docs/superpowers/specs/2026-07-20-wiki-locate-and-orient-tools-design.md`](2026-07-20-wiki-locate-and-orient-tools-design.md), [`TODO_LIST.md`](../../../TODO_LIST.md) item "Wiki Write Tooling"

## Purpose

Give the chat agent, AfterAgent Middleware, and (once it exists) Thread Type
2 a single, shared write path into the knowledge base — two agent-callable
tools, `wiki_create_page` and `wiki_update_page`, backed by shared
non-LLM functions that both the tools and AfterAgent call directly. Today
AfterAgent is the only code that writes to the wiki, calling
`LlmWiki.ingestPrep()`/`commitPage()`/`saveRawSource()` itself; this spec
extracts that write logic into a reusable layer and exposes it as tools, so
future write paths (Thread Type 2, triggered tasks) don't reimplement it.

This is also a deliberate change to who can write during a live
conversation. Until now, the wiki has been read-only during a Thread Type 1
turn — AfterAgent, running in the background after the SSE stream closes,
has been "the only write path for Thread Type 1"
(`2026-07-17-afteragent-middleware-design.md`). This spec adds the new tools
to the live chat agent's tool list too, so the model can write to the wiki
mid-conversation, same as any other tool call, alongside AfterAgent's
existing background pass. The two are independent and can both act on the
same turn — no explicit-vs-implicit distinction or de-duplication guardrail
is being added; the risk of a double-write on the same fact is accepted and
mitigated only incidentally, by `wiki_create_page`'s duplicate-detection
(see below), which applies equally regardless of caller.

## In scope

- `api/src/services/wiki-write.ts` — `createWikiPage()` / `updateWikiPage()`,
  the shared, structured, non-LLM write functions.
- `api/src/agents/tools/wiki-create-page.tool.ts` and
  `wiki-update-page.tool.ts` — thin LangChain tool wrappers around the above,
  following the existing pattern in `wiki-read-page.tool.ts`.
- Wiring both tools into `chat-agent.ts`'s tool list (Thread Type 1).
- Refactoring `after-agent.ts` to call `createWikiPage()`/`updateWikiPage()`
  instead of calling `LlmWiki.commitPage()` directly.
- Dry-run support on both tools.
- Path-escape validation for `wiki_update_page` (the SDK itself has none —
  see below).
- Reviving the two deferred `wiki-navigation.yaml` scenarios (`wnav-007`,
  `wnav-008`) that were written but intentionally left out pending these
  tools, plus a new `suites/wiki-write.yaml` for write-specific behavior
  (dry-run, duplicate-refusal, path validation).

## Out of scope

- Thread Type 2 itself — these tools are a prerequisite, not part of it.
- The AfterAgent explicit/implicit write-source distinction discussed and
  explicitly rejected during design (see Purpose) — no guardrail is added.
- `wiki_lint` (separate TODO item).
- A distinct free-text "commit message" concept in `LlmWiki`'s log format —
  see the note under `wiki_update_page` below; this spec reuses the
  existing `summary` field instead of extending `appendLog`.
- Any change to `LlmWiki`, `WikiRegistry`, or their library-level tests.

## Shared write functions (`api/src/services/wiki-write.ts`)

Both functions are plain, structured, non-LLM async functions — no
LangChain dependency. They're the single place page-write logic lives;
the tools and AfterAgent are both thin callers.

```ts
export interface WikiWriteResult {
  path: string; // relative to the wiki root
  created: boolean;
  warnings: Warning[];
}

export type CreateWikiPageResult =
  | { status: 'written'; result: WikiWriteResult }
  | { status: 'dry_run'; title: string; wikiId: string; section: PageType }
  | { status: 'duplicate'; existingPath: string }
  | { status: 'wiki_unavailable' }
  | { status: 'unknown_wiki'; wikiId: string };

export async function createWikiPage(params: {
  wikiId: string;
  title: string;
  content: string;
  section: PageType; // 'entity' | 'concept' | 'comparison' | 'query' | 'summary'
  tags?: string[]; // default []
  sources?: string[]; // default [] — AfterAgent passes [rawSource.path]; tool calls omit it
  summary?: string;
  dryRun?: boolean;
}): Promise<CreateWikiPageResult>;

export type UpdateWikiPageResult =
  | { status: 'written'; result: WikiWriteResult }
  | { status: 'dry_run'; path: string; existingBody: string; proposedBody: string }
  | { status: 'not_found' }
  | { status: 'invalid_path' }
  | { status: 'wiki_unavailable' }
  | { status: 'unknown_wiki'; wikiId: string };

export async function updateWikiPage(params: {
  wikiId: string;
  path: string;
  content: string;
  tags?: string[]; // omitted -> reuse existing page's tags
  sources?: string[]; // omitted -> reuse existing page's sources
  summary?: string;
  dryRun?: boolean;
}): Promise<UpdateWikiPageResult>;
```

### `createWikiPage()` behavior

1. Resolve the registry via `getWikiRegistry()`; on failure return
   `{ status: 'wiki_unavailable' }`. Load `wikiId` via `registry.load()`;
   on failure return `{ status: 'unknown_wiki', wikiId }`. No throwing
   across the function boundary — both failure modes are result variants
   the caller (tool wrapper or AfterAgent) can act on, mirroring the two
   distinct fallback strings the existing read tools already use for these
   same two cases.
2. Call `wiki.ingestPrep({ content, keywords: tags })`.
3. If `prep.existingPages[0]` exists, return
   `{ status: 'duplicate', existingPath: prep.existingPages[0] }` without
   writing. The function does not attempt a merge — it has no LLM reasoning
   available to merge bodies coherently (unlike AfterAgent's dedicated merge
   step, described below). Pushing the decision back to the caller is
   correct specifically because every caller of this function (the live
   agent, Thread Type 2, or AfterAgent's own pre-check) is itself
   LLM-driven and can decide what to do next — re-read the existing page and
   call `updateWikiPage`, or ask the user.
4. Otherwise, if `dryRun`, stop here and return
   `{ status: 'dry_run', title, wikiId, section }` without calling
   `commitPage`. This does not include the exact path a real write would
   produce (`type` + slugified `title`) because that's computed by
   `pagePathFor()`, an internal helper not exported from
   `@tkottke90/llm-wiki`'s public API (`lib/llm-wiki/src/index.ts`) —
   reimplementing that slugification here would risk silently drifting from
   the real algorithm, and exporting it is a library change out of this
   spec's scope (see Out of scope). The create dry-run preview therefore
   reports title/wikiId/section, not the exact future path.
5. Otherwise call `wiki.commitPage({ type: section, title, tags: tags ?? [], sources: sources ?? [], body: content, summary, relPath: undefined })` and return `{ status: 'written', result }`.

### `updateWikiPage()` behavior

1. Resolve the registry via `getWikiRegistry()`; on failure return
   `{ status: 'wiki_unavailable' }`. Load `wikiId` via `registry.load()`;
   on failure return `{ status: 'unknown_wiki', wikiId }`. Same two variants
   as `createWikiPage()`, above.
2. Resolve `path` against `wiki.basePath` with `path.resolve` and reject
   anything that escapes it: `path.resolve(wiki.basePath, path).startsWith(path.resolve(wiki.basePath))`.
   Return `{ status: 'invalid_path' }` on failure. **This check does not
   exist in the SDK today** — `LlmWiki`'s private `abs()` is a bare
   `path.join(this.basePath, rel)` with no traversal guard (confirmed by
   reading `llm-wiki.ts`). Every existing read tool takes a `path` that
   originated from `wiki_search`'s own results, so this has never mattered
   before; `wiki_update_page` is the first tool to accept an arbitrary
   agent-supplied path used for a _write_, so the guard belongs here.
3. Read the existing page (`readPage` or equivalent). Not found →
   `{ status: 'not_found' }`.
4. Determine effective `tags`/`sources`: use the params if provided,
   otherwise carry forward the existing page's frontmatter values unchanged.
5. If `dryRun`, stop here and return
   `{ status: 'dry_run', path, existingBody, proposedBody: content }`
   without calling `commitPage` — unlike create, there's a real existing
   body to diff against, so the dry-run result carries both bodies and lets
   the tool wrapper render the actual diff text (see below).
6. Otherwise call `commitPage({ ..., relPath: path })` and return
   `{ status: 'written', result }`.

## Tool 1: `wiki_create_page`

**File:** `api/src/agents/tools/wiki-create-page.tool.ts`

**Schema:**

```ts
const WikiCreatePageSchema = z.object({
  wikiId: z
    .string()
    .describe('Wiki domain ID to create the page in, from wiki_locate or wiki_search.'),
  title: z.string().describe('Page title.'),
  content: z.string().describe('Page body as markdown (no frontmatter).'),
  section: z
    .enum(['entity', 'concept', 'comparison', 'query', 'summary'])
    .describe(
      '"entity" for a specific person/place/thing/organization, "concept" for an idea, ' +
        '"comparison" for content contrasting two or more things, "query" for a captured ' +
        'question-and-answer, "summary" for a higher-level rollup.',
    ),
  tags: z.array(z.string()).optional().describe('Tags for the new page.'),
  dryRun: z
    .boolean()
    .optional()
    .describe('If true, report what would be created without writing anything.'),
});
```

**Behavior:** calls `createWikiPage()` and formats the result:

- `'written'`: `Created page "<title>" at <path>.`
- `'dry_run'`: `[dry run] Would create a new "<section>" page titled "<title>" in wiki "<wikiId>".`
  (no exact path — see the function behavior above for why)
- `'duplicate'`: `A similar page already exists at <existingPath>. Read it with wiki_read_page and call wiki_update_page instead.`
- `'wiki_unavailable'`: `'Wiki knowledge base is not available.'` (matches the existing read tools' fallback string).
- `'unknown_wiki'`: `Wiki "<wikiId>" is not registered. Use wiki_locate to find available domains.` (matches `wiki-read-page.tool.ts`'s existing message).

**Tool description:**

> Create a new wiki page. If a similar page already exists, this returns a
> pointer to it instead of writing — read it with wiki_read_page and call
> wiki_update_page with merged content instead of creating a duplicate. Use
> dryRun to preview without writing.

## Tool 2: `wiki_update_page`

**File:** `api/src/agents/tools/wiki-update-page.tool.ts`

**Schema:**

```ts
const WikiUpdatePageSchema = z.object({
  wikiId: z.string().describe('Wiki domain ID the page belongs to.'),
  path: z
    .string()
    .describe('Existing page path relative to the wiki root, from wiki_search or wiki_read_page.'),
  content: z.string().describe('Full replacement page body as markdown (no frontmatter).'),
  summary: z
    .string()
    .optional()
    .describe(
      'One-line summary for the wiki index entry, and the closest thing to a commit message this tool supports.',
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe('If true, return a diff of what would change without writing anything.'),
});
```

**Note on "commit message":** `LlmWiki.commitPage()` auto-appends a
`log.md` entry (`action: update`, `subject: title`) with no room for a
free-text reason — there's no commit-message concept in the SDK to plumb
through. This spec maps the TODO's "updated content with a commit message"
onto the existing optional `summary` field (the index one-liner) rather
than extending `LlmWiki.appendLog`'s shape, which would be a
library-level change beyond this item's scope.

**Behavior:** calls `updateWikiPage()` and formats the result:

- `'written'`: `Updated page at <path>.` plus any SDK warnings appended
  (e.g. few-wikilinks), same style as other tools.
- `'dry_run'`: `[dry run] Would update <path>:\n<diff>`, where `<diff>` is a
  compact line-based diff of `existingBody` vs. `proposedBody` (a small
  local helper, no new dependency).
- `'not_found'`: `Page not found at <path>. Use wiki_create_page for a new page.`
- `'invalid_path'`: `Invalid path.`
- `'wiki_unavailable'` / `'unknown_wiki'`: same fallback strings as `wiki_create_page`, above.

**Tool description:**

> Update an existing wiki page's content. Requires the page's existing path
> (from wiki_search or wiki_read_page) — use wiki_create_page for a page
> that doesn't exist yet. Use dryRun to preview the change as a diff without
> writing.

## Wiring

Both tools are added to `buildChatAgent`'s tool list in
`api/src/agents/chat-agent.ts`:

```ts
tools: [
  askUserTool,
  uploadImageTool,
  wikiSearchTool,
  wikiReadPageTool,
  wikiLocateTool,
  wikiOrientTool,
  wikiCreatePageTool,
  wikiUpdatePageTool,
  ...mcpTools,
],
```

This makes Thread Type 1 able to write to the wiki mid-conversation for the
first time — see the note in Purpose. `system-prompt.ts`'s harness sections
are not being changed as part of this spec; whether the model reaches for
these tools proactively or only on explicit request is left to the model's
own judgement and the eval suite below, not to new prompt guidance. If real
usage shows a wording gap (over-writing, under-writing), that's a
follow-up to `system-prompt.ts` under the existing "Agent Behavior
Baseline" pattern, not part of this item.

## AfterAgent refactor (`api/src/agents/after-agent.ts`)

`runAfterAgentPipeline()`'s write step changes from direct SDK calls to
calling the shared functions, while keeping the parts that are genuinely
AfterAgent-specific:

1. classify → shouldWrite (unchanged)
2. extract → domainId/type/title/tags/body/summary (unchanged)
3. `wiki.ingestPrep()` — **stays a direct SDK call.** AfterAgent needs the
   `prep` result (`sha256`, `existingPages`) before deciding whether to run
   its LLM merge step below; `createWikiPage()`'s internal `ingestPrep` call
   exists for callers that don't already have this information, and calling
   it a second time from inside `createWikiPage()` on the no-match path is
   a cheap, harmless recheck, not a behavior change.
4. `wiki.saveRawSource()` — **stays a direct SDK call.** Raw-provenance
   snapshotting is an AfterAgent-specific concern (a live tool call has no
   "raw source" to snapshot), not part of the shared write path.
5. If `prep.existingPages[0]` exists: run the existing LLM merge step
   (unchanged), then call
   `updateWikiPage({ wikiId, path: existingMatch, content: mergedBody, tags: extract.tags, sources: [rawSource.path], summary: extract.summary })`.
6. Otherwise call
   `createWikiPage({ wikiId, title, content: extract.body, section: extract.type, tags: extract.tags, sources: [rawSource.path], summary: extract.summary })`.
7. On `'written'`, call `queueWikiUpdate(...)` exactly as today — the
   background-write chip stays queued-and-drained-next-turn, unchanged.
   On any other status (`'duplicate'`, `'not_found'`, `'invalid_path'` —
   none expected in practice given step 3's pre-check, but handled
   defensively), log a warning and call `setAfterAgentDone(threadId, 'no-op')`,
   the same defensive posture the current unknown-domainId branch already
   uses.

**Explicitly not changed:** the live agent's own `wiki_create_page`/
`wiki_update_page` tool calls do **not** call `queueWikiUpdate()` or emit a
`wiki_updated` SSE event. A live write is already visible in the stream as
an ordinary tool-call event; the `wiki_updated` chip remains exclusive to
AfterAgent's background writes, where it's the only signal the UI gets
since those writes happen after the stream has already closed.

## Testing

`wiki-write.ts` gets real unit tests (`wiki-write.test.ts`), following the
same convention `after-agent.test.ts` already uses: a real `LlmWiki`
instance against a temp directory (`mkdtempSync`/`rmSync`), not mocks — the
project has no mocking library. Cases: create (new page), create
(duplicate detected), create (dry-run), update (existing page), update
(not found), update (invalid/escaping path), update (dry-run diff), update
with omitted tags/sources carrying forward the existing page's values.

The two new tool wrapper files (`wiki-create-page.tool.ts`,
`wiki-update-page.tool.ts`) get **no dedicated unit tests**, matching the
existing convention for `wiki-locate.tool.ts`/`wiki-orient.tool.ts`/
`wiki-read-page.tool.ts`: `getWikiRegistry()` is a lazy singleton bound to
`env.wikiRoot` with no DI seam, and these files are thin formatting wrappers
around `wiki-write.ts`, which does carry real test coverage. Manual
verification checklist to run against the real `config/kb` wiki during
implementation:

- [ ] `wiki_create_page` — new page written, correct path/frontmatter
- [ ] `wiki_create_page` — duplicate detected, no write, pointer message
- [ ] `wiki_create_page` — `dryRun: true`, no write, preview message
- [ ] `wiki_update_page` — existing page updated, tags/sources preserved when omitted
- [ ] `wiki_update_page` — unknown path → not-found message
- [ ] `wiki_update_page` — `../`-style escaping path → invalid-path message, no write
- [ ] `wiki_update_page` — `dryRun: true` → diff shown, no write
- [ ] AfterAgent's existing merge-then-write flow still produces the same
      on-disk result as before the refactor (re-run `after-agent.test.ts`)

`after-agent.test.ts` is updated in place for the refactor (same
describe/it structure, assertions now checking the shared function's
result shape where the current tests inspect `CommitResult` fields
directly).

## Evaluation Scenarios

`suites/wiki-navigation.yaml` already documents two scenarios that were
deliberately deferred pending these tools:

- `wnav-007-locate-orient-update-existing-page` — locate+orient show an
  existing on-topic page; asked to update it, the agent calls
  `wiki_update_page`.
- `wnav-008-locate-orient-create-new-page` — locate+orient show nothing
  on-topic; asked to add something, the agent calls `wiki_create_page`
  rather than hallucinating an edit to an unrelated page.

Both are added as real, runnable `tool-sequence` scenarios as part of this
item (they were written and reviewed already — see
`2026-07-20-wiki-locate-and-orient-tools-design.md`'s "deferred" note — this
spec just removes the "deferred" status).

A new suite, `suites/wiki-write.yaml`, covers write-specific behavior the
navigation suite doesn't:

| id                                        | type            | what it proves                                                                                                                                                                                                           |
| ----------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wwrite-001-create-dry-run`               | `tool-call`     | Asked to preview adding a page without saving it, the agent calls `wiki_create_page` with `dryRun: true`.                                                                                                                |
| `wwrite-002-update-dry-run`               | `tool-call`     | Asked to preview a change to an existing page, the agent calls `wiki_update_page` with `dryRun: true`.                                                                                                                   |
| `wwrite-003-duplicate-create-then-update` | `tool-sequence` | Seeded `wiki_create_page` result is `'duplicate'` (the tool's own string), pointing to an existing path; the agent's next call is `wiki_read_page` or `wiki_update_page` on that path, not a retried `wiki_create_page`. |
| `wwrite-004-explicit-save-request`        | `tool-call`     | Asked directly to save a specific fact to the wiki, the agent calls `wiki_create_page` or `wiki_update_page` (not just a prose acknowledgement).                                                                         |

As with `wiki-navigation.yaml`, seeded tool results in `wwrite-003` must be
wrapped as `{ text: "<tool's actual string output>" }` — `PriorToolTurnSchema.result`
is `z.record(string, unknown)`, not a bare string.

## Open items deferred to later TODO work

- Any explicit/implicit write-source distinction or de-duplication
  guardrail between the live agent's writes and AfterAgent's — considered
  and explicitly rejected during design (see Purpose); revisit only if real
  usage shows duplicate/conflicting writes are a frequent, observed problem.
- Thread Type 2 wiring these tools into its own loop — belongs to that
  item once it exists.
- A true free-text commit-message / audit-trail concept in `LlmWiki`'s log
  format — would require a library-level change to `appendLog`.
