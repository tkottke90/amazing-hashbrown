# Wiki Locate & Orient Tools — Design

**Date:** 2026-07-20
**Status:** Approved (design)
**Related:** [`docs/Design/2026-07-04-llm-wiki-repository-layer-design.md`](../../Design/2026-07-04-llm-wiki-repository-layer-design.md) (the underlying `@tkottke90/llm-wiki` library), [`TODO_LIST.md`](../../../TODO_LIST.md) item "Wiki Orient Tool (`wiki.orient()`)"

## Purpose

Expose two agent-callable LangChain tools that let the chat agent (and, later,
the automated-task agent) navigate the knowledge base before reading or
writing to it:

- **`wiki_locate`** — find which registered wiki domain matches a topic, or
  discover that none does.
- **`wiki_orient`** — given a specific domain, load its structural state
  (tag taxonomy, page index, recent activity) before searching or writing.

Both wrap already-implemented, already-tested methods on `@tkottke90/llm-wiki`
(`WikiRegistry.resolve()` / `.list()` / `.routingNotes()` and
`LlmWiki.orient()`). No library changes are required — this spec is scoped
entirely to the thin `api/src/agents/tools/*.tool.ts` wrapper layer and its
wiring into `chat-agent.ts`, following the existing pattern established by
`wiki-search.tool.ts` and `wiki-read-page.tool.ts`.

## Scope note: two tools, one TODO item

The TODO list names a single item, "Wiki Orient Tool," and its stated
requirement was to check whether `LlmWiki.orient()` exists and add it if not.
It already exists and is fully tested. Working through the design surfaced
that the TODO's description conflated two distinct jobs — *picking* a domain
and *orienting inside* one already-picked domain — that map cleanly onto two
separate, single-purpose tools rather than one tool with two modes. This spec
covers both as one unit of work since they were discovered together and are
small individually.

## In scope

- `wiki_locate` tool: domain discovery via the registry's existing routing
  scorer, plus a no-argument browse mode.
- `wiki_orient` tool: full orientation on one named domain, with index
  truncation for oversized wikis.
- Wiring both into `buildChatAgent`'s tool list in `chat-agent.ts`.

## Out of scope

- Thread Type 2 (Automated Task) itself — these tools are a prerequisite for
  it, not part of it. The "inject orientation context automatically at the
  start of a task turn" behavior described in the TODO belongs to that
  later item, not this one.
- Creating a new wiki domain when `wiki_locate` finds no match. The registry
  already supports this (`WikiRegistry.create()`), but it is a write
  operation with real disk side effects (new directories, `registry.json`
  mutation) and belongs with the not-yet-built "Wiki Write Tooling" TODO
  item. `wiki_locate` only *detects and reports* a no-match state.
- Any change to `LlmWiki`, `WikiRegistry`, or their underlying tests in
  `lib/llm-wiki` — this spec only adds an application-layer wrapper.
- Unit tests for the new tool files (see Testing, below).

## Tool 1: `wiki_locate`

**File:** `api/src/agents/tools/wiki-locate.tool.ts`

**Purpose:** answer "which wiki domain(s) apply here?" using the registry's
existing deterministic scorer, so the agent doesn't have to guess a `wikiId`
before it can call `wiki_orient` or `wiki_read_page`.

**Schema:**

```ts
const WikiLocateSchema = z.object({
  context: z
    .string()
    .optional()
    .describe(
      'Free-text description of the topic or task to match against a wiki domain. ' +
        'Omit to browse all registered domains and their routing hints instead.',
    ),
});
```

**Behavior:**

1. Resolve the registry via `getWikiRegistry()`. On failure, return
   `'Wiki knowledge base is not available.'` (matches the existing tools'
   fallback string).
2. If `registry.list()` is empty, return `'No wiki domains are configured.'`
3. **`context` provided** — call `registry.resolve(context)`:
   - Match (`{ path, id, domain, score }`) → format as:
     `Best match: "<id>" (domain: <domain>, score <score>). Use wiki_orient({ wikiId: "<id>" }) to see what's inside.`
   - Ambiguous (`{ ambiguous: true, candidates }`) → list the tied candidate
     ids and prompt the agent to narrow the context or ask the user.
   - No match (`{ noMatch: true, available }`) → list the available domain
     ids and state plainly that none matched; no creation action is taken or
     suggested beyond that.
4. **`context` omitted** — browse mode: return `registry.list()` (id, domain,
   tags, status) formatted as a short table/list, followed by
   `registry.routingNotes()` (the raw `"<triggers> -> <wiki-id>"` lines) so
   the agent can read the routing hints directly.

**Error handling:** mirrors `wiki-search.tool.ts` — registry construction
failures are caught and return a plain-text fallback rather than throwing;
this is a read-only tool with no partial-failure surface (it touches only
registry-level metadata, not per-wiki files).

## Tool 2: `wiki_orient`

**File:** `api/src/agents/tools/wiki-orient.tool.ts`

**Purpose:** answer "what's in this specific wiki?" once the agent already
has a `wikiId` (from `wiki_locate`, from a prior `wiki_search` result, or
because it's hardcoded for a single-domain deployment).

**Schema:**

```ts
const WikiOrientSchema = z.object({
  wikiId: z.string().describe('Wiki domain ID to orient on (e.g. "user"), as returned by wiki_locate or wiki_search.'),
});
```

`wikiId` is **required** — domain selection is `wiki_locate`'s job. This
also means `wiki_orient` only ever operates on one wiki per call, so there is
no cross-domain payload-size composition to worry about.

**Behavior:**

1. Resolve the registry via `getWikiRegistry()`. On failure, return
   `'Wiki knowledge base is not available.'`
2. `registry.load(wikiId)` — on failure (unknown id), return:
   `Wiki "${wikiId}" is not registered. Use wiki_locate to find available domains.`
   (mirrors `wiki-read-page.tool.ts`'s existing error message style).
3. Call `wiki.orient()` → `{ schema, index, recentLog }`. Format as:

   ```
   # Wiki Orientation: <wikiId>

   ## Schema
   <schema content>

   ## Index
   <index content, truncated if oversized>

   ## Recent Log
   - [date] action | subject
   ...
   ```

4. **Index truncation:** `index.md` is a line-oriented catalog (one entry per
   page, maintained by `nav.upsertIndexEntry`). If its content exceeds
   **4000 characters**, truncate by **whole lines**, not a raw character
   slice — cutting mid-entry would leave a dangling, misleading summary
   instead of one entry cleanly omitted. Append a note stating how many more
   entries were cut, e.g.:
   `[index truncated — N more entries omitted; use wiki_search for details]`.
   `schema` and `recentLog` are not truncated — they're small by
   construction (a tag taxonomy and the last 30 log entries).

**Error handling:** same fallback-string style as the other wiki tools;
no throwing across the tool boundary.

## Wiring

Both tools are added to `buildChatAgent`'s tool list in
`api/src/agents/chat-agent.ts`, alongside the existing wiki tools:

```ts
tools: [
  askUserTool,
  uploadImageTool,
  wikiSearchTool,
  wikiReadPageTool,
  wikiLocateTool,
  wikiOrientTool,
  ...mcpTools,
],
```

They are available to the current chat agent (Thread Type 1) immediately,
not gated behind Thread Type 2 — they're harmless, read-only tools that are
also useful in ordinary conversation (e.g. "what's in the wiki?").

## Testing

Neither `wiki-search.tool.ts` nor `wiki-read-page.tool.ts` has a dedicated
unit test file. `getWikiRegistry()` is a lazy module-level singleton bound to
`env.wikiRoot` / `process.cwd()` with no dependency-injection seam, and the
project has no mocking library (`mocha` + `chai` only — no `sinon`/`esmock`
in `api/package.json`'s devDependencies). This spec follows that same
established convention: no unit tests for `wiki-locate.tool.ts` or
`wiki-orient.tool.ts`. Correctness rests on the existing library-level test
coverage for `WikiRegistry` and `LlmWiki` (89 tests per the library's
README), plus a manual sanity check (build + a scripted tool call against
the real `config/kb` wiki) during implementation.

## Open items deferred to later TODO work

- Actual domain creation when `wiki_locate` reports no match (belongs with
  Wiki Write Tooling).
- Automatic orientation-context injection at the start of a Thread Type 2
  turn (belongs with Thread Type 2 itself).
- Exposing `orient()`'s `recent` log-count parameter to the agent — left
  hardcoded at the library default (30) for simplicity; revisit only if an
  agent flow is observed needing a different window.
