# Design: Conditional Ambient Context for Workspace Chat

For [issue #248](https://github.com/tkottke90/amazing-hashbrown/issues/248).
Builds on #244's ambient-context mechanism
(`api/src/agents/ambient-context.ts` / `.middleware.ts`) and its research doc,
`docs/research/issue-244/01-ambient-context-survey.md`.

## 1. Overview

#244 added one universal, fresh-every-model-call ambient fact (current
date/time) shared by all five agent-builder call sites. Workspace chat
additionally carries its own cached, build-time system-prompt block
(`buildWorkspaceContextBlock()`, `api/src/agents/chat-agent.ts`) with
workspace-specific facts (name, location, goal, wiki domain, prior-work
summaries). This issue asked which *additional* workspace-chat-specific
facts are worth adding to that block, evaluated against real failure modes
rather than speculative usefulness.

Four candidates were named in the issue. Investigating them turned up two
findings that reshape scope before any implementation:

1. **The cache/freshness split is load-bearing.** `buildWorkspaceContextBlock()`
   is baked into the system prompt once, at agent-build time, and the built
   agent is cached per `workspaceId` (`_workspaceAgents` in `chat-agent.ts`),
   invalidated only on goal/systemPrompt/wikiId changes or a new summary —
   never on a timer, never per-turn. Any *relative-time* phrasing
   ("generated 3 days ago") baked into that block would go stale exactly the
   way the pre-#244 bare-date bug did: frozen at whatever it was when the
   agent was last built, silently wrong by the time a long-lived cached agent
   serves a later turn. The universal `current_time` provider avoids this by
   being fresh-per-call via `ambientContextMiddleware`. Any new fact that
   needs relative framing has to respect this split.
2. **`lastChange` isn't a real signal today.** `touchWorkspace()`
   (`api/src/services/workspace-store.ts:944`), the only method that would
   update `last_change` on real workspace activity, has zero callers anywhere
   in the repo. In practice `last_change`/`updated_at` are only ever written
   at creation or on an explicit metadata edit (`patchWorkspace`) — never on
   chat or task activity. Surfacing "last touched" today would show a false
   fact for any actively-used, unedited workspace.

## 2. Candidate Evaluation

| # | Candidate | Verdict | Evidence |
|---|---|---|---|
| 1 | `description` not surfaced in chat context | **Confirmed** | `Workspace.description` exists, is distinct from `goal` (which *is* surfaced), and `WorkspaceChatContext`/`buildWorkspaceContextBlock()` have no path to it at all. A plain omission, not a judgment call. |
| 2 | Summary recency has no relative framing | **Confirmed** | The model already receives absolute `olderSummaries[].timestamp` values (cached, safe — they never change once written) and a fresh current-time fact (ambient, ratified by #244). Nothing today tells the model to compare the two. |
| 3 | Workspace age / staleness (`createdAt`, `updatedAt`, `lastChange`) | **Confirmed, narrowed to `createdAt` only** | `createdAt` is immutable post-creation — safe to cache, same relative-framing gap as summaries. `lastChange` is **rejected**: per finding 2 above, it doesn't track what it claims to. Recommend a separate follow-up issue to wire `touchWorkspace()` into real activity (chat turns, task runs) before reconsidering it as an ambient fact. `updatedAt` is redundant with `createdAt`/`lastChange` for this purpose (it moves on *any* field patch, including unrelated metadata edits) and isn't worth a third, confusing "recency" fact. |
| 4 | Task/kanban snapshot | **Deferred, out of scope for this issue** | Needs new aggregation (`listTasks()` + `board-rules.ts`'s lane computation), not a reframe of an existing field — a meaningfully different cost category. Tracked as a separate follow-up issue per the original issue's own flag that this is "worth naming but not assuming is worth the cost." |

(A fifth candidate — surfacing the workspace's on-disk location for
`shell_exec` — was raised and dropped during brainstorming: `Location on
disk: ${ctx.location}` is already an unconditional line in
`buildWorkspaceContextBlock()` today, and that same `ctx.location` is already
passed to `makeShellExecTool()` as its working directory. No gap exists.)

**Two follow-up issues to file separately** (not part of this design):
- Wire `touchWorkspace()` into real workspace activity, then reconsider
  surfacing `lastChange`/"last touched" as an ambient fact.
- Task/kanban open/overdue counts as workspace chat context (candidate 4).

## 3. Approach for Relative-Time Framing

Two real candidates (summary recency, workspace age) need the model to
reason about "how long ago," which risks the staleness bug in finding 1.
Three approaches were weighed:

- **Rejected — bake relative strings into the cached block.** Reintroduces
  the exact bug class #244 fixed; a cached agent reused across a long-lived
  workspace thread would serve an increasingly wrong "N days ago."
- **Rejected (for now) — a new fresh-per-call workspace-scoped ambient
  provider.** Extend `ambient-context.ts` with a second provider list and a
  `createWorkspaceAmbientContextMiddleware(workspaceId)` that re-reads the
  live workspace row every model call and computes the relative phrase
  itself. Guaranteed-correct regardless of agent-cache lifetime, but adds a
  new provider/middleware concept, a per-turn DB read, and non-trivial new
  code for what is fundamentally subtraction between two values the model
  can already see.
- **Chosen — let the model do the arithmetic.** Expose only *absolute*
  timestamps (both of which are safe to cache: `createdAt` never changes,
  and `olderSummaries[].timestamp` is already cached today), and add one
  instruction inviting the model to compare them against the already-fresh
  ambient current-time fact. No new architecture, no new per-turn I/O —
  composes two pieces that already exist (the cached workspace block, the
  fresh ambient current-time provider) instead of building a third
  mechanism to do what's effectively `now - then`.

This is a deliberate bet that model date-arithmetic is reliable enough to
not need harness-guaranteed phrasing — which is exactly what the eval
scenarios in §5 exist to check, and exactly why this stays an *addition* to
the existing `ambient-context.yaml` discipline of "don't ship a provider
without a scenario that would catch it regressing."

## 4. Implementation

**`api/src/agents/chat-agent.ts`** (`WorkspaceChatContext` interface):
- Add `description: string | null`
- Add `createdAt: string`

**`buildWorkspaceContextBlock()`**:
- Render `description` conditionally (same pattern as `goal`): `Description:
  ${ctx.description}`, placed directly after the opening "working within"
  line, before `Goal:`.
- Render `createdAt` unconditionally (it's always set) via the existing
  `formatRunTime()` helper (`task-context.ts`, already used for run
  timestamps elsewhere) and `env.timezone` — same formatting convention the
  rest of the codebase uses for absolute times: `Created: ${formatRunTime(ctx.createdAt, env.timezone)}`.
- Add one shared instruction line (not duplicated per-fact) telling the
  model to cross-reference dated facts in this block against the ambient
  current-time fact to judge recency — covers both the new `createdAt` line
  and the existing `olderSummaries[].timestamp` list without hardcoding any
  "N days ago" string itself.
- Export the function (currently private) so it can be unit-tested directly
  — see §5.

**`api/src/agents/workspace-chat-stream-handler.ts`** (`buildWorkspaceContext()`):
- Copy `workspace.description` and `workspace.createdAt` through into the
  returned `WorkspaceChatContext`, alongside the existing fields. No new
  I/O — `workspace` is already the full row.

**`api/src/agents/task-execution.ts`**: no change needed — it reuses
`buildWorkspaceContext()` for the same workspace-context block in automated
task runs (per that file's own header comment), so the new fields flow
through automatically.

No changes to `ambient-context.ts`, `ambient-context.middleware.ts`, or any
other agent-builder call site — this stays entirely inside the
workspace-chat-specific, cached block, per the chosen approach in §3.

## 5. Testing

**Unit tests** (`chat-agent.test.ts`, new — `buildWorkspaceContextBlock` has
no dedicated tests today):
- Renders `Description: ...` when `ctx.description` is set; omits the line
  when `null` (mirrors the existing `goal`/`wikiDomain` conditional pattern).
- Renders `Created: ...` via `formatRunTime`, always (not conditional).
- Includes the recency-framing instruction line.

**`workspace-chat-stream-handler.test.ts`** (extend existing
`buildWorkspaceContext()` suite): asserts `description` and `createdAt` on
the returned context match the input `Workspace` row.

**Eval suite — new `suites/workspace-chat-context.yaml`** (not an addition
to `suites/ambient-context.yaml`: that suite's own stated purpose is
one-scenario-per-`ambient-context.ts`-provider, and these facts deliberately
live in the workspace-chat-specific cached block instead, per §3 — a
separate suite keeps that boundary visible in the eval tree the same way
it's visible in the code). Candidate scenarios, following the isolation
discipline `ambient-context.yaml` itself uses (one fact per scenario, a bare
question with no competing tool-choice complexity), with a pinned
`simulatedNow` the same way `ambient-context.yaml` does:

- Agent states the workspace's description when asked, without needing a
  tool call (`tool-call` type, `'!shell_exec'`).
- Agent states roughly how old the workspace is, given a seeded `createdAt`
  and pinned `simulatedNow` (`tool-call` + `responseRubric`, same shape as
  `ambient-context.yaml`'s date scenarios — scoring an approximate-but-correct
  relative phrase, e.g. "about 3 months").
- Agent states roughly how long ago the most recent *older* summary was
  generated, given a seeded `olderSummaries` entry and pinned `simulatedNow`.

**Per root `AGENTS.md`'s Evaluation-Driven Development rules, these
scenarios are written as part of this work but cannot be run or confirmed
from this session** — there's no network path to the local model providers
the suites run against. They ship as failing-until-verified scenarios; the
user runs `npm run eval -- --suite workspace-chat-context --model <provider>
--judge-model <provider>` (or the `auto-eval-loop` skill) to confirm the
"model does the arithmetic" bet in §3 actually holds before this is
considered done. If it doesn't hold for a given scenario, the fallback is
the rejected-for-now approach in §3 (harness-precomputed phrasing for that
specific fact), not a weaker rubric.

## 6. Error Handling

No new failure modes: `description` and `createdAt` are plain fields off an
already-loaded `Workspace` row (no new I/O, no new nullability beyond what
`description: string | null` already models). The existing `try/catch`
around summary-file loading in `loadWorkspaceSummaries()` is untouched.
