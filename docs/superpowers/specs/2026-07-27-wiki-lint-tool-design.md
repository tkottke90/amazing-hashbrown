# Wiki Lint Tool — Design

**Date:** 2026-07-27
**Status:** Approved (design)
**Related:** [`docs/Design/2026-07-04-llm-wiki-repository-layer-design.md`](../../Design/2026-07-04-llm-wiki-repository-layer-design.md) (the underlying `@tkottke90/llm-wiki` library and its `lint()` engine), [`docs/Design/2026-07-17-afteragent-middleware-design.md`](../../Design/2026-07-17-afteragent-middleware-design.md), [`docs/superpowers/specs/2026-07-26-wiki-write-tooling-design.md`](2026-07-26-wiki-write-tooling-design.md), [`TODO_LIST.md`](../../../TODO_LIST.md) item "Wiki Lint Tool"

## Purpose

**Why this is needed:** the wiki now has two independent, largely
unsupervised write paths — the live agent's `wiki_create_page`/
`wiki_update_page` tool calls, and AfterAgent's background LLM-extraction
pipeline, which by explicit design (see `2026-07-26-wiki-write-tooling-design.md`'s
Purpose) has no de-duplication or human-review guardrail against the
other. Every one of those writes, and every read (`wiki_search`,
`wiki_read_page`, `wiki_orient`), currently trusts the wiki's content
without any way to check it's actually still coherent. That trust is
misplaced by construction: pages get renamed or replaced and leave dangling
`[[wikilinks]]` elsewhere, AfterAgent's automated merge step can drift a
page's frontmatter, content goes stale without anyone revisiting it, and
nothing currently notices any of this — a broken link or a stale fact
just gets fed back into the next `wiki_search` result as if it were fine,
compounding quietly over time. `LlmWiki.lint()` already exists to catch
exactly these problems; the gap is that nothing calls it. This item closes
that gap by giving both write paths a way to check their own work: the
live agent gets a tool to explicitly check wiki health, and AfterAgent —
the higher-risk path, since its writes ship with no human review at all —
gets an automatic check after every commit. It's also a hard prerequisite
for Thread Type 2 (Automated Task), which is specified to call
`wiki.lint()` before declaring an autonomous task complete; an agent
operating without a human in the loop needs its own way to verify it
didn't leave the knowledge base in a broken state.

**What ships:** expose the already-implemented `LlmWiki.lint()` /
`WikiRegistry.lint(id)` engine (12 checks: orphans, broken links, missing
index entries, frontmatter, page size, tag audit, source drift, log
rotation, staleness, quality flags, contradictions, registry sync) as an
agent-callable `wiki_lint` tool, and hook it into AfterAgent Middleware as
a background health check after every write it commits. Unlike Wiki Write
Tooling, this item requires no new mechanical layer — `WikiRegistry.lint(id)`
already loads the wiki and injects the registry data the `registry_sync`
check needs — so this spec is entirely about the two call sites (the tool
wrapper and the AfterAgent hook), not new wiki mechanics.

## In scope

- `api/src/agents/tools/wiki-lint.tool.ts` — a thin LangChain tool wrapper
  around `WikiRegistry.lint(id)`, following the pattern in
  `wiki-orient.tool.ts`.
- Wiring the tool into `chat-agent.ts`'s tool list (Thread Type 1) and
  `bin/eval.ts`'s registered tool set.
- A post-write lint call inside `after-agent.ts`'s `runAfterAgentPipeline()`,
  logging findings — no behavioral change beyond logging.
- A new `suites/wiki-lint.yaml` eval suite.
- Adding a new "Wiki Lint Remediation Tools" item to `TODO_LIST.md`'s
  Outstanding Items, capturing the deliberately deferred remediation gap
  (see "Read-only, on purpose" below).

## Out of scope

- Any change to `LlmWiki`, `WikiRegistry`, or the lint engine itself
  (`lib/llm-wiki/src/internal/lint/*`) — it's already complete and tested.
- Making lint findings fixable by the agent beyond what the existing write
  tools already support (see "Read-only, on purpose" and the new
  "Wiki Lint Remediation Tools" TODO item this spec adds).
- Surfacing lint results in the UI/SSE layer (e.g. extending the
  `wiki_updated` event with a lint summary) — considered and rejected for
  this round; AfterAgent's use of lint is logging-only.
- The "standalone maintenance tool the user can trigger from the Settings
  page" idea mentioned in the TODO item — blocked on Settings Page UI,
  which doesn't exist yet.
- Thread Type 2's use of `wiki.lint()` before declaring a task complete —
  belongs to that item once it exists; this spec only makes the tool
  available for it to call later.

## Read-only, on purpose

Cross-checking each lint check against the existing write tools
(`wiki_create_page`, `wiki_update_page`) shows the agent can act on only
a subset of what lint can report:

| Finding                     | Fixable today with existing tools?                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `broken_links`               | Yes — read the referencing page, fix/remove the wikilink, `wiki_update_page`               |
| `index`                      | Yes — re-save via `wiki_update_page`; `commitPage()` always re-syncs `index.md`             |
| `stale`                      | Yes — re-save via `wiki_update_page`; `commitPage()` always bumps `updated` to today        |
| `orphans`                    | Partially — no dedicated cross-link tool exists (`LlmWiki.addCrossLink()` isn't wrapped); the agent would have to hand-edit another page's body |
| `tag_audit`                  | No — `wiki_update_page`'s tool schema doesn't expose `tags`, even though the service function does |
| `frontmatter` (title/type)   | No — `updateWikiPage()` always carries forward the existing `title`/`type` verbatim         |
| `quality` / `contradictions` | No — `confidence`/`contested`/`contradictions` aren't parameters anywhere in the write path |
| `source_drift` / `registry_sync` | No — no tool touches raw-source re-saving or registry registration                      |
| `page_size` / `log_rotation` | N/A — informational/structural, not a single-page fix                                       |

Given that, `wiki_lint` ships as a pure diagnostic this round. Its tool
description tells the agent which findings it can act on today
(broken_links/index/stale, via `wiki_read_page` + `wiki_update_page`) and
to say so to the user rather than claim to fix findings it has no tool
path for. The full remediation gap — exposing `tags` on `wiki_update_page`,
adding `confidence`/`contested`/`contradictions` to both write tools, and a
cross-link tool for `orphans` — is tracked as a new, separate Outstanding
Item so it gets its own design pass rather than expanding this one.

## Tool: `wiki_lint`

**File:** `api/src/agents/tools/wiki-lint.tool.ts`

**Schema:**

```ts
const WikiLintSchema = z.object({
  wikiId: z
    .string()
    .describe('Wiki domain ID to lint, as returned by wiki_locate or wiki_search.'),
});
```

One domain per call, matching `wiki_orient`/`wiki_update_page` — not an
optional-wikiId "lint everything" mode. This keeps the tool's cost bounded
and matches AfterAgent's need (lint the one domain it just wrote to).
Linting the whole registry, if ever needed, is a matter of the agent
calling this once per domain from `wiki_locate`'s domain list.

**Behavior**, mirroring `wiki-orient.tool.ts`'s error handling:

- `getWikiRegistry()` fails → `'Wiki knowledge base is not available.'`
- `registry.lint(wikiId)` throws (unregistered id — same failure mode as
  `registry.load()`) → `'Wiki "<id>" is not registered. Use wiki_locate to
  find available domains.'`
- Otherwise, format the `LintReport` as a grouped text block: a status
  line (`ok`/counts by severity), then findings grouped `## Errors` /
  `## Warnings` / `## Info`, each line `- [<check>] <page>: <message>`
  (page omitted for registry-level findings like `registry_sync`). When
  `report.checks.length === 0`: `"Wiki '<id>' is healthy — no issues
  found."`

**Tool description:**

> Run the wiki's health checks (broken links, orphaned pages, missing
> frontmatter, stale content, tag/index drift, and more) against one
> domain. Read-only — reports issues without fixing them. For
> `broken_links`, `index`, and `stale` findings, use `wiki_read_page` and
> `wiki_update_page` to fix them; other finding types (tags, confidence,
> contradictions, orphans) don't have a fix path with the current
> toolset — say so rather than attempting a workaround.

**Wiring:** added to `buildChatAgent`'s tool list in `chat-agent.ts` and
to `bin/eval.ts`'s registered tool set, alongside the other wiki tools.

## AfterAgent integration (`api/src/agents/after-agent.ts`)

After a successful write (`writeResult.status === 'written'`, right after
the existing `queueWikiUpdate(...)` / `setAfterAgentDone(threadId,
'identified')` block), add a post-write lint check:

```ts
try {
  const lintReport = await registry.lint(domainEntry.id);
  const errors = lintReport.checks.filter((c) => c.severity === 'error');
  if (errors.length) {
    logger.warn('after-agent: lint found errors after write', {
      threadId,
      wikiId: domainEntry.id,
      errors,
    });
  } else if (lintReport.checks.length) {
    logger.info('after-agent: lint found non-error findings after write', {
      threadId,
      wikiId: domainEntry.id,
      findingCount: lintReport.checks.length,
    });
  }
} catch (err) {
  logger.warn('after-agent: lint failed after write', {
    threadId,
    err: serializeError(err),
  });
}
```

Design points:

- **Own `try`/`catch`**, separate from the pipeline's outer one — a lint
  failure must never flip the already-successful write's outcome to
  `'error'`; that status reflects the write, not the lint check that ran
  after it.
- **Logging only** — no SSE/schema changes, no blocking, no change to
  `setAfterAgentDone`'s outcome. This was a deliberate choice: extending
  `wiki_updated` with a lint summary was considered and explicitly
  deferred (see Out of scope) pending a clearer signal for what "flag a
  problem" should look like in the UI.
- Runs on `domainEntry.id` — the one domain just written to — not a
  full-registry sweep, so cost stays proportional to one write.
- `registry` is already in scope at this point in the function (used to
  `load()` the domain for `ingestPrep`/`saveRawSource` earlier in the same
  block), so no new plumbing is needed.

## Testing

- **No new tool-level unit test file** — matches the existing convention:
  `wiki-orient.tool.ts`, `wiki-locate.tool.ts`, and `wiki-search.tool.ts`
  have no dedicated unit tests, since they're thin formatting wrappers
  around already-tested library calls (`lib/llm-wiki/test/lint.test.ts`
  covers all 12 checks at the library level) and `getWikiRegistry()` is a
  lazy singleton with no DI seam.
- **`after-agent.test.ts`** gets new cases for the post-write lint hook:
  - lint report contains an error finding → `logger.warn` called with the
    error findings.
  - lint report is clean (no findings) → no warn/info call.
  - `registry.lint()` throws → caught and logged; `setAfterAgentDone`'s
    outcome from the write step (`'identified'`) is unchanged.

## Evaluation Scenarios (`suites/wiki-lint.yaml`)

New suite, `tool-call` scenarios seeded with `wiki_locate`/`wiki_orient`
prior turns so the domain is already established, matching
`wwrite-001`'s pattern in `suites/wiki-write.yaml`:

| id                             | type        | what it proves                                                                                                                    |
| ------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `wlint-001-check-wiki-health`   | `tool-call` | Asked to check the wiki for issues, with the domain already established via seeded `wiki_locate`/`wiki_orient` prior turns, the agent calls `wiki_lint` with the matching `wikiId`. |
| `wlint-002-locate-before-lint`  | `tool-sequence` | Asked to check the wiki for issues with **no** domain established yet, the agent calls `wiki_locate` first rather than guessing a `wikiId`, matching the established locate-before-act pattern from `wnav-011`/`wnav-012` and `wwrite-001`. |

Two scenarios to start, the same size as the initial pass of
`suites/wiki-write.yaml`'s dry-run coverage — real eval runs against
`ornith`/`glm` during implementation may surface additional scenarios or
wording fixes, following the same iterate-against-real-runs process
documented inline in those suites and in `system-prompt.ts`.

`wikiLintTool` is registered in `bin/eval.ts` alongside the other wiki
tools so these scenarios are runnable.

No scenario asserts the agent *fixes* a lint finding — consistent with
"Read-only, on purpose" above, that would test against a capability this
spec deliberately doesn't ship.

## Follow-up: new TODO_LIST item

This spec adds **"Wiki Lint Remediation Tools"** to `TODO_LIST.md`'s
Outstanding Items, depending on Wiki Lint Tool: expose `tags` on
`wiki_update_page`, add `confidence`/`contested`/`contradictions` params to
both write tools, and a cross-link tool for `orphans` — so the agent (and
eventually Thread Type 2, which is expected to call `wiki.lint()` before
declaring a task complete) can act on every lint finding, not just the
subset reachable today.

## Open items deferred to later TODO work

- Full lint-finding remediation — tracked as the new "Wiki Lint
  Remediation Tools" TODO item above.
- Surfacing lint results in the UI (SSE event extension, dashboard
  widget) — revisit once there's a concrete UI surface driving the
  requirement (Dashboard System, or a richer `wiki_updated` event).
- Thread Type 2 wiring `wiki_lint` into its own loop — belongs to that
  item once it exists.
- The "standalone maintenance tool" on the Settings page — blocked on
  Settings Page UI.
