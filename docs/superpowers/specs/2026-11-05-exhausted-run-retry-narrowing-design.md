# Exhausted-run retry narrowing — design

Issue: [tkottke90/amazing-hashbrown#369](https://github.com/tkottke90/amazing-hashbrown/issues/369)

## Problem

A Run that fails by hitting a hard resource limit (an **Exhausted Run** — see
GLOSSARY.md) currently retries, via cron re-fire or a human dragging the
Task back to `queue`, with identical scope and no memory of what the prior
attempt already tried. It tends to fail the same way again at even higher
cost. Observed in the gmail-labeler workspace: a test-fix Task's first Run
overflowed after 79 tool calls / 220 `shell_exec` commands; its retry
overflowed again, at nearly double the token count, before finally
completing.

## Design

The full architectural decision — the `failure_reason` field, Exhausted
Run, Scope Snapshot, Exhaustion Streak, Exhaustion Cap, Narrowed Retry, the
new `exhaustion_cap` Hand-Off Cause, the cron/drag-to-queue gating, and the
rejected alternatives — is recorded in **ADR-0056**. The Task Drawer's
Hand-Off Guidance resolution flow (generalized to every Hand-Off Cause, not
just `exhaustion_cap`) is recorded in **ADR-0057**. GLOSSARY.md defines
every capitalized term used below. This document does not restate either —
it's the implementation plan for both.

## Scope

In scope: ordinary (board-visible) Tasks only. A Sub-Agent Task never
reaches the board or the Task Drawer, so none of the Exhaustion
Streak/Cap/Narrowed Retry/Hand-Off Guidance machinery here has anything to
act on for one — see ADR-0056's Scope note. No new board-level badge or
indicator beyond the Task Drawer changes below.

## Implementation plan

### 1. `failure_reason` on `task_queue`

Add a migration: `failure_reason TEXT NULL`, values `'out_of_steps'` |
`'turn_overflow'` | `'other'`. Populate it in `task-execution.ts`'s existing
failure handling:

- Generic/else branch (~1049–1102): `failure_reason: 'out_of_steps'` when
  `err.name === 'GraphRecursionError'`, else `'other'`.
- `ContextBudgetExceededError` branch (~1036–1048): `failure_reason:
'turn_overflow'`.
- `StagnationLimitError` branch (~1022–1035): `failure_reason: 'other'` —
  this branch is sub-agent-only (`escalationMode: 'throw'`); it doesn't
  participate in anything below, but the column should still be populated
  for consistency.

A pre-existing `'failed'` row (written before this migration) reads as
`failure_reason: null`, which the Exhaustion Streak query (below) must treat
the same as `'other'` — it never contributes to a streak.

### 2. Scope Snapshot

Add `scope_title TEXT NULL` / `scope_description TEXT NULL` to
`task_queue`, written once at every Run's kickoff (not only Exhausted-Run
kickoffs — simpler to always capture it than to special-case when). The
unchanged-scope check compares the _current_ Task's title/description
(trimmed, whitespace-normalized) against the _most recent Exhausted Run's_
Scope Snapshot.

### 3. Exhaustion Streak

A new query alongside `failedRunStreaks()` in `workspace-store.ts`: walk a
Task's Runs newest-first, counting while `failure_reason` is `'out_of_steps'`
or `'turn_overflow'` **and** each Run's Scope Snapshot matches the one
before it; stop at the first Run that's a success, a non-Exhausted failure,
or a scope change. The resulting count (0, 1, or more) drives steps 4–5.

### 4. Narrowed Retry

When a Task is (re-)enqueued (`enqueueTask()` in `workspace-store.ts`, both
the cron and manual drag-to-queue paths) and the Exhaustion Streak count is
exactly 1 with unchanged scope: this Run is the Narrowed Retry. Add a new,
dedicated one-shot LLM summarizer (new file, e.g.
`api/src/agents/exhausted-run-summarizer.ts`, following the
`workspace-summarizer.ts` precedent) that condenses the prior Exhausted
Run's transcript into "what was already tried / ruled out." Inject its
output as a new, additive section in `buildRunKickoff()`
(`task-context.ts`), alongside the existing one-line summary and Handoff
Notes, together with an explicit statement that a second Exhausted Run will
hand the Task off. Persist the generated summary on this Run's own row
(reuse `scope_description`'s sibling pattern, or a new `retry_context TEXT`
column — implementation's call) rather than regenerating it if read again.

### 5. Exhaustion Cap

When the Exhaustion Streak count would become 2 with unchanged scope (i.e.
the Narrowed Retry itself also ends as an Exhausted Run with unchanged
scope): settle the Run as `handed_off` / Task `blocked`, with a new
`handoff_reason` column on `task_queue` (`'agent_requested'` |
`'exhaustion_cap'`) set to `'exhaustion_cap'`. Populate `'agent_requested'`
at the existing `hand_off_task` tool's write path
(`task-execution.ts:779`) so every `handed_off` row has a cause from this
point forward.

### 6. Cron gating

In `store.fireCronTask()`'s existing gate (`scheduled` and enabled): also
skip firing while the Task's current status is `handed_off`, regardless of
`handoff_reason`.

### 7. Drag-to-queue gating

In `board-rules.ts`'s move-plan for dragging a `blocked`/`handed_off` Task
to `queue`: reject (409, same pattern as the existing chat/retry/fork
rejections) when `handoff_reason === 'exhaustion_cap'` **and** the Task's
current title/description still matches the capping Run's Scope Snapshot.
No gating change for `'agent_requested'`.

### 8. Task Drawer — Hand-Off Guidance

- Distinguish a hand-off-caused `blocked` Task from an ordinary manual
  pause in whatever the drawer reads today (the generic "Paused task
  controls" panel currently can't tell them apart) — needs the latest Run's
  `status`/`handoff_reason`/`summary` to reach the Task detail response.
- Add a labeled "Why this got stuck" section showing the Hand-Off Note
  (`task_queue.summary`), and a free-text Hand-Off Guidance field, both
  shown whenever the Task's latest Run is `handed_off`, for either
  `handoff_reason`.
- On save: a new route (e.g. `POST /api/v1/tasks/:id/hand-off-guidance`)
  takes the guidance text, calls a new one-shot LLM function with (current
  title, current description, Hand-Off Note, guidance text), and on success
  writes the result through the same path `patchTaskHandler` uses — not a
  parallel persistence mechanism. On failure, return an error; do not write
  anything.
- No auto re-enqueue. The human drags the Task back to `queue` afterward via
  the existing Resume action.

## Testing

Per root AGENTS.md: every new route, service function, and middleware
change above needs developer tests (unit for the Exhaustion Streak query,
the `failure_reason`/`handoff_reason` classification branches, and the
condensed/guidance-merge summarizers with a stubbed model; orchestration for
the `enqueueTask`/cron/board-rules wiring, following the existing
`board-rules.test.ts` move-table pattern; external-orchestration for the new
LLM calls' error handling). New UI behavior (the drawer's Hand-Off
Guidance/Hand-Off Note section) needs Playwright E2E coverage in the same
PR, per the root AGENTS.md E2E rules.

Per the root AGENTS.md's EDD rules: both new one-shot LLM calls (the
condensed-summary generator and the guidance-merge rewriter) are
LLM-facing behavior and need a failing eval scenario authored before
implementation, with the actual eval run handed off to the user per EDD
rule 5 (this session has no network path to run `npm run eval` itself).
