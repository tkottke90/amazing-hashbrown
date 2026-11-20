# Wiki Ingestion Agent: Missing Rebaseline Tool & Tool-Capture Gap — Design

**Date:** 2026-11-20
**Status:** Approved
**Issue:** None (found via thread-report review — see Background)
**Depends on:** None (extends `docs/superpowers/specs/2026-09-27-per-turn-tool-availability-design.md`)

---

## 1. Background & Problem

A user ran wiki-maintenance work in the wiki chat (`wiki-ingestion-agent.ts`, served via
`wiki-stream-handler.ts`). The model (`Digital Ocean/glm-5.3-flash`) hit `source_drift` lint
findings and repeatedly said `wiki_rebaseline_source` "isn't exposed in my current toolset,"
declared the fix impossible from that session, and surfaced a HITL prompt asking the user to run
the rebaseline externally.

Investigation initially assumed this was a model reasoning error, since `wiki_rebaseline_source`
is catalogued `alwaysOn: true` (`api/src/agents/tool-catalog.ts`) and is bound everywhere else
(`buildChatAgent`, `buildWorkspaceChatAgent`, `buildTaskAgent`, sub-agent candidates) via
`buildWikiWriteTools()` in `api/src/agents/chat-agent.ts`. That assumption was wrong.

**The wiki ingestion agent is a fourth, independent agent builder** (`buildWikiIngestionAgent()` in
`api/src/agents/wiki-ingestion-agent.ts`) that hand-lists its own `tools: [...]` array instead of
reusing `buildWikiWriteTools()`. It includes `makeWikiCreatePageTool()`, `makeWikiUpdatePageTool()`,
and `makeWikiAddCrossLinkTool()` — but not `makeWikiRebaselineSourceTool()`. The tool was added to
the codebase 2026-10-26; this file has been touched three times since without it being added here.
`wiki-ingestion-agent.ts` also never runs `toolAccessMiddleware`, so the catalog's `alwaysOn`
guarantee never reaches this agent at all — the model was telling the truth.

This was hard to confirm from the thread report alone because the wiki ingestion agent is also one
of the agents the Sep 27, 2026 per-turn-tool-availability design explicitly scoped *out* of
tool-capture ("Agents that do not use the `chat-agent.ts` middleware chain ... Their traces render
'tools not captured'") — exactly what the report showed. Had that agent's bound-tool list been
captured, this would have been visible immediately instead of requiring a code read.

A second, smaller gap surfaced during the same investigation: the model's workaround attempt (using
`wiki_update_page`'s `sourceText` param to "re-baseline") failed, and re-linting after confirmed it
— `sourceText` saves a provenance snapshot via `wiki.saveRawSource()`, a completely separate write
path from the sha256 baseline `wiki_lint`'s `source_drift` check reads, which only
`wiki.rebaselineRawSource()` (called exclusively by `wiki_rebaseline_source`) updates.
`wiki_update_page`'s `sourceText` field description says nothing about this.

**Goal:** close the actual tool gap, document the `sourceText` limitation, and extend tool-capture
to the wiki ingestion agent so a recurrence of "model claims a tool is missing" is provable from the
thread report alone, without a code read.

---

## 2. Scope

**In scope:**

1. Make `wiki_rebaseline_source` actually bound in the wiki ingestion agent.
2. Document that `wiki_update_page`'s `sourceText` does not reset the `source_drift` baseline.
3. Extend per-turn tool-capture (`docs/superpowers/specs/2026-09-27-per-turn-tool-availability-design.md`)
   to the wiki ingestion agent, and correct that design doc's now-stale scope note.

**Out of scope:**

- Further consolidating the wiki ingestion agent's tool list with `buildChatAgent`/
  `buildWorkspaceChatAgent`/`buildTaskAgent` beyond the four wiki-write tools. The agents genuinely
  differ elsewhere (no `toolAccessMiddleware`/tool-settings governance, no sub-agent concerns,
  `escalationMode: 'interrupt'` vs. task agents' `'throw'`, different middleware chains) —
  unifying further is unrelated to this bug.
- Any change to `wiki_lint`'s own fix-path text (already correctly says `source_drift` →
  `wiki_rebaseline_source`).
- Any system-prompt change. This is a tool-binding bug and two documentation/observability gaps,
  not a prompting gap.
- Backfilling `tools` for historical wiki-ingestion traces (same "not backfilled" rule the Sep 27
  design already established for chat/workspace/task traces).

---

## 3. Fix 1 — Bind the missing tool

`api/src/agents/wiki-ingestion-agent.ts`, `buildWikiIngestionAgent()`'s `tools` array (currently
lines 48-62):

Replace the three individual calls:

```ts
makeWikiCreatePageTool(),
makeWikiUpdatePageTool(),
makeWikiAddCrossLinkTool(),
```

with:

```ts
...buildWikiWriteTools(),
```

`buildWikiWriteTools()` (`api/src/agents/chat-agent.ts`, already `export`ed) returns exactly these
three tools plus `makeWikiRebaselineSourceTool()` — same shape, same call signatures (each factory
takes no arguments in both current call sites), so this is a direct substitution with no behavior
change to the three tools already present. The only observable effect is that
`wiki_rebaseline_source` becomes available.

Reusing the shared function (rather than adding the fourth call by hand) is deliberate, per this
repo's composition-over-customization principle: the previous hand-maintained duplicate is exactly
how this tool went missing for three weeks across three unrelated PRs. A shared array can't drift
the same way — the next tool added to `buildWikiWriteTools()` is automatically present here too.

Import `buildWikiWriteTools` from `./chat-agent.js`; drop the now-unused individual imports
(`makeWikiCreatePageTool`, `makeWikiUpdatePageTool`, `makeWikiAddCrossLinkTool`) from
`wiki-ingestion-agent.ts`.

---

## 4. Fix 2 — Document the `sourceText` limitation

`api/src/agents/tools/wiki-update-page.tool.ts`, `WikiUpdatePageSchema`'s `sourceText` field
description. Append one sentence stating it does not reset the `source_drift` sha256 baseline, and
naming `wiki_rebaseline_source` as the correct tool for that. Matches this file's existing pattern
of narrow, dated-reasoning comments above a field when a past failure motivated wording (see the
`confidence` field's comments) — except this is a forward-looking correctness note, not a
past-failure log, so it goes in the description text itself (visible to the model), not a code
comment.

No schema change — `sourceText`'s type and optionality are unchanged.

---

## 5. Fix 3 — Tool-capture for the wiki ingestion agent

Extends `docs/superpowers/specs/2026-09-27-per-turn-tool-availability-design.md` rather than
duplicating it. Two changes, both smaller than that design's original estimate for this agent
because the groundwork already exists:

1. **Middleware:** add `modelInputSnapshotMiddleware` (`api/src/agents/model-input-snapshot.middleware.ts`,
   already used by `buildChatAgent`/`buildWorkspaceChatAgent`/`buildTaskAgent`) to
   `buildWikiIngestionAgent()`'s `middleware` array in `wiki-ingestion-agent.ts`. Same import, same
   placement rule as the existing three call sites (last in the array, innermost `wrapModelCall`).

2. **`trace_id` plumbing: already done, no change needed.** The Sep 27 design had to add `trace_id`
   plumbing to `stream-handler.ts`/`workspace-chat-stream-handler.ts` by hand because those call
   sites still use the older inline `startTrace`/`ObservabilityCallbackHandler`/`endTrace` pattern.
   `wiki-stream-handler.ts` already uses the newer `turn-observability.ts` helper
   (`startTurnObservability().attach(config)`), which already merges `trace_id` into `configurable`
   at all three of its call sites. `modelInputSnapshotMiddleware` reads `configurable.trace_id` the
   same way regardless of which turn runner supplied it, so no plumbing work is needed here —
   adding the middleware is sufficient.

No changes needed to `lib/observability` (the `tools` column and `recordModelInput` already exist
and are agent-agnostic) or `lib/thread-reports` (chip rendering keys off `trace.tools`/
`trace.systemPrompt`, not agent type). Both already work for any trace once it's captured.

**Correct the Sep 27 design doc:** its §2 "Out of scope" line —

> Agents that do not use the `chat-agent.ts` middleware chain (e.g. wiki ingestion, plan
> generation). Their traces render "tools not captured".

— is no longer accurate for wiki ingestion once this ships. Update it to name only plan generation,
and add a one-line note cross-referencing this spec for wiki ingestion's inclusion.

---

## 6. Testing

Mocha + Chai, tags per root `AGENTS.md`.

**`api/src/agents/wiki-ingestion-agent.test.ts`** (new or extended, mirroring existing
tool-list-shape tests elsewhere, e.g. `chat-agent.test.ts`'s wiki-write-tool assertions):

- the built agent's tool list includes `wiki_rebaseline_source` `[unit]`
- the built agent's tool list still includes `wiki_create_page`, `wiki_update_page`,
  `wiki_add_cross_link` (regression guard for the substitution) `[unit]`
- the built agent's middleware array includes `modelInputSnapshotMiddleware` `[unit]`

**`api/src/agents/tools/wiki-update-page.tool.test.ts`**

- `sourceText`'s schema description mentions `wiki_rebaseline_source` and that it does not reset
  the drift baseline `[unit]` — a plain string-content assertion, not a snapshot of the whole
  description, so unrelated wording changes elsewhere in the field don't break this test.

**`api/src/agents/wiki-stream-handler.test.ts`** (orchestration, mirroring the pattern the Sep 27
design specified for `stream-handler.test.ts`):

- with the real middleware chain, a wiki-ingestion turn records a `tools` snapshot on the trace
  containing `wiki_rebaseline_source` `[orchestration]`

**No changes needed** to `lib/observability` or `lib/thread-reports` tests — existing coverage for
`recordModelInput` and chip rendering already covers any trace with a `tools` value, agent-agnostic.

**Evals:** none required — this is a tool-binding/observability fix, not an LLM-facing behavior
change under `suites/*.yaml`'s EDD rules. (A pre-existing `wiki-lint`/`wiki-write` suite scenario
exercising `wiki_rebaseline_source` end-to-end in the wiki ingestion agent would be a reasonable
follow-up, but authoring one is not required to close this gap, which was a binding bug, not a
prompting one.)

---

## 7. Acceptance Criteria Mapping

| Problem                                                              | Covered by |
| --------------------------------------------------------------------| ---------- |
| `wiki_rebaseline_source` unreachable from wiki chat                 | §3         |
| `sourceText` silently doesn't fix `source_drift`                    | §4         |
| Thread report can't confirm/deny a "tool missing" claim for wiki chat | §5       |
| Stale Sep 27 design doc scope note                                  | §5 (doc update) |
| Regression: future tool additions to `buildWikiWriteTools()` silently missing here | §3 (reuse, not re-duplicate) |
