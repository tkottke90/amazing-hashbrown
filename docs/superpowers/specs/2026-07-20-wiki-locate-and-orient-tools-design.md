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

**`wiki_locate` vs. `wiki_search` — domain-level vs. content-level.**
`wiki_search` already loops every registered domain and searches page
*content* (`wiki-search.tool.ts:27-51`), answering "which pages match this
query" — but only once matching content exists. `wiki_locate` answers a
coarser, prior question — "which domain applies to this topic at all" —
using the registry's deterministic id/domain/tag/routing-note scorer,
independent of whether any page content exists yet. This distinction
matters most before writing (no page exists yet for search to find) or when
a domain is relevant but has no content on the specific topic yet. The two
tools are complementary, not overlapping: `wiki_locate` operates on
registry metadata; `wiki_search` operates on page bodies.

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
- A light, description-only edit to the existing `wiki-search.tool.ts` —
  no behavior change, just clarifying it already searches content across
  all domains, and pointing to `wiki_locate`/`wiki_orient` for the
  domain-level and full-catalog cases respectively.
- A new evaluation suite (`suites/wiki-navigation.yaml`) regression-testing
  tool coordination across `wiki_locate` → `wiki_orient` →
  `wiki_search`/`wiki_read_page`/`ask_user` (see Evaluation Scenarios,
  below).

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

**Tool description** (the LangChain `description` field, distinct from the
per-field zod `.describe()`):

> Find which wiki domain matches a topic, using deterministic routing
> (id/domain/tag/routing-note hits) — a domain-level lookup, not a content
> search. Or list all domains and their routing hints if you don't have a
> specific topic yet. Call this first when you don't already know a
> wikiId — before wiki_orient, wiki_search, or wiki_read_page. Score
> reflects match strength: double digits is a strong signal (an id or
> routing-note hit); a lone score of 2-3 is a weak, single-tag coincidence —
> use judgement.

The score-reading guidance exists because `registry.resolve()`'s scorer has
no built-in confidence threshold — any score > 0 is reported as a match,
even a single coincidental tag hit (+3). Surfacing the raw score and how to
read it lets the agent apply judgement rather than treating every non-zero
score as equally confident.

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

**Tool description:**

> Load a wiki domain's full structural state — tag taxonomy, page index,
> recent activity — before searching or writing in it. Call this once you
> already have a wikiId (from wiki_locate or a wiki_search result) and want
> the lay of the land before deciding what to search for or write.

**Error handling:** same fallback-string style as the other wiki tools;
no throwing across the tool boundary.

## Existing tool update: `wiki_search` description

Light, description-only edit to `api/src/agents/tools/wiki-search.tool.ts`
(no behavior change) to disambiguate it from the two new tools:

> Search page content for a query across every registered wiki domain.
> Returns ranked results with wikiId and path. Use wiki_locate first if you
> want to know which domain covers a topic before any matching pages exist,
> or wiki_orient for a domain's full catalog rather than a ranked subset.
> Use wiki_read_page to fetch the full content of a specific result.

## Wiring

Both tools are added to `buildChatAgent`'s tool list in
`api/src/agents/chat-agent.ts`, alongside the existing wiki tools:

```ts
tools: [askUserTool, uploadImageTool, wikiSearchTool, wikiReadPageTool, wikiLocateTool, wikiOrientTool, ...mcpTools],
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

### Manual verification checklist

Run these by hand against the real `config/kb` wiki during implementation,
since there is no automated test net (see above):

**`wiki_locate`**
- [ ] `context` matches exactly one domain cleanly
- [ ] `context` produces an ambiguous tie between two+ domains
- [ ] `context` matches no domain
- [ ] `context` omitted — browse mode lists all domains + routing notes
- [ ] Zero domains registered
- [ ] Registry unavailable (e.g. point `WIKI_ROOT` somewhere invalid)

**`wiki_orient`**
- [ ] Known `wikiId` with a small index — full content returned, no truncation
- [ ] Known `wikiId` with an artificially oversized index — truncates cleanly
      on a line boundary with an accurate omitted-count note
- [ ] Empty schema/index/log (freshly created domain)
- [ ] Unknown `wikiId` — points back to `wiki_locate`
- [ ] Registry unavailable

## Evaluation Scenarios

The evaluation harness (`lib/evaluations`) already supports the kind of
multi-tool coordination testing this feature needs, via the `tool-sequence`
scenario type (`lib/evaluations/src/executors/tool-sequence.ts`): it seeds N
prior tool calls into a conversation as if they already happened (each
becoming its own `AIMessage(tool_call)` + `ToolMessage(result)` pair — see
`runner.ts`'s `buildSeededMessages`), then checks the agent's *next* live
tool call. `suites/tool-calling.yaml`'s `tools-002-comfyui-then-upload`
scenario is the existing precedent for this pattern.

Add a new suite, `suites/wiki-navigation.yaml` (auto-discovered by
`loader.ts`'s recursive directory scan of the suites directory — no
manifest registration needed), covering coordination across `wiki_locate` →
`wiki_orient` → `wiki_search`/`wiki_read_page`/`ask_user`:

| id | type | what it proves |
|----|------|-----------------|
| `wnav-001-locate-picks-domain` | `tool-call` | Given a topic clearly belonging to one domain, the agent calls `wiki_locate` with a `context` arg. |
| `wnav-002-orient-after-locate` | `tool-sequence` | Seeded `wiki_locate` result shows a clean match; the agent's next call is `wiki_orient({ wikiId })` with that id. |
| `wnav-003-read-page-after-orient` | `tool-sequence` | Seeded `wiki_locate` + `wiki_orient` results show a relevant page in the index; asked a question that page answers, the agent's next call is `wiki_read_page` with the right path. |
| `wnav-004-ambiguous-locate-asks-user` | `tool-sequence` | Seeded `wiki_locate` result has `ambiguous: true` with two tied candidates; the agent's next call is `ask_user`, not a guess. |
| `wnav-005-no-match-reports-honestly` | `llm-judge` | For a topic no real domain covers, the agent states plainly that nothing matched instead of fabricating an answer. No seeding needed — the live registry naturally returns no match. |
| `wnav-006-unknown-wikiid-recovers` | `tool-sequence` | Seeded `wiki_orient` call with a bad id returns the tool's own "not registered — use wiki_locate" string; the agent's next call is `wiki_locate`. |

Note: `PriorToolTurnSchema.result` is `z.record(string, unknown)`
(`schemas.ts:61-65`) — since these tools return plain strings, wrap seeded
results as `{ text: "<tool's actual string output>" }` (`runner.ts`
JSON-stringifies whatever object is given verbatim into the `ToolMessage`
content, so this is a convention, not a schema requirement).

**Deferred, documented but not added as runnable scenarios yet** — these
would require a tool that doesn't exist until "Wiki Write Tooling" ships;
adding them now would just be permanent failing entries dragging down the
suite's `passingThreshold`:

- `wnav-007-locate-orient-update-existing-page` — locate+orient show an
  existing on-topic page; asked to update it, the agent should call the
  future `wiki_update_page`.
- `wnav-008-locate-orient-create-new-page` — locate+orient show *nothing*
  on-topic; asked to add something, the agent should call the future
  `wiki_create_page` rather than hallucinating an edit to an unrelated page.

Add these two for real once Wiki Write Tooling exists.

## Open items deferred to later TODO work

- Actual domain creation when `wiki_locate` reports no match (belongs with
  Wiki Write Tooling).
- Automatic orientation-context injection at the start of a Thread Type 2
  turn (belongs with Thread Type 2 itself).
- Exposing `orient()`'s `recent` log-count parameter to the agent — left
  hardcoded at the library default (30) for simplicity; revisit only if an
  agent flow is observed needing a different window.
