# Handed-Off Run Outcome — Design

**Date:** 2026-11-01
**Status:** Approved
**Issue:** [#364 — No run status distinguishes a clean human-in-the-loop handoff from an actual stalled failure](https://github.com/tkottke90/amazing-hashbrown/issues/364)
**Decisions:** [ADR-0054](../../adr/0054-handed-off-runs-use-an-explicit-tool-and-a-new-status-literal.md)
**Glossary:** [Run, Handed-Off Run, Stalled Run](../../../GLOSSARY.md#task-runs)

---

## 1. Problem & Goal

A Run that hits a real problem, correctly triggers `ask_user`, gets told by the user to stop, and produces a clean summary ends up recorded identically to a Stalled Run or a genuine crash: `task_queue.status: 'failed'`, with the agent's actual summary text discarded in favor of a canned "ran out of steps" message (`api/src/agents/task-execution.ts:774-783`). This skews `failedRunStreaks()` (`api/src/services/workspace-store.ts:2154-2177`) and therefore every failure count a workspace retrospective surfaces.

**Goal:** a Run that cooperatively ends mid-HITL with a real summary is recorded as a Handed-Off Run — distinct from `done`, `failed`, and `cancelled` — flows through transcript reading and retrospectives the same way the other finished outcomes already do, and a Stalled Run's real summary text (when it produced one) is no longer discarded.

**Out of scope (decided, see ADR-0054 and grilling round answers):**

- Any new `Task.status` literal. A Handed-Off Run's owning Task settles to the existing `blocked` value.
- A dedicated dashboard widget type for handoffs. This issue surfaces the count through the existing retrospective aggregator/narrative only.
- Consolidating `TaskQueueEntry['status']`, the in-memory `finalOutcome` union, and `RunOutcome` (`api/src/routes/v1/tasks.handlers.ts:133`) into one shared type. These three independently-defined, overlapping unions all get `'handed_off'` added, but stay separate. **File a follow-up issue to review the ROI of consolidating them** (see §7).
- Gating `hand_off_task`'s visibility in the tool list on run history. It is unconditionally present, like `complete_task` and `ask_user`.

## 2. Approach

Add one new outcome, `handed_off`, produced only by a new tool, `hand_off_task`, built as a direct sibling of `complete_task` (`api/src/agents/tools/complete-task.tool.ts`) and reusing its nudge-once validation pattern rather than inventing a new one (ADR-0054). Separately, fix the Stalled Run branch to stop discarding the agent's real last message.

## 3. Components

### 3.1 New tool: `api/src/agents/tools/hand-off-task.tool.ts`

Modeled directly on `makeCompleteTaskTool`:

```ts
export function makeHandOffTaskTool(
  taskId: string,
  entry: TaskQueueEntry,
  opts: { onAccepted?: () => void },
): StructuredTool; // tool name: hand_off_task, schema: { summary: string }
```

- Description: tells the model this ends the Run cooperatively when the user has asked it to stop mid-conversation, and that it requires a summary of what was done and what's left.
- **Nudge-once validation**, same mechanic as `complete_task`'s plan-steps check: the **first** call is rejected with a reminder (not ending the Run) if `entry.pauseReason !== 'chat'` — i.e. no `ask_user` interrupt has occurred yet in this Run — pointing the agent at `complete_task` (if actually done) or `ask_user` (if it needs to ask something) instead. A **second** call is accepted unconditionally, exactly like `complete_task`'s own second-call behavior.
- `entry.pauseReason` is readable here because `resumePausedEntry()` (`workspace-store.ts:2627-2629`) deliberately leaves `pause_reason`/`paused_at` in place across a resume — no new column or state needed.
- Only an accepted call fires `opts.onAccepted?.()`, same "single source of truth" box pattern `complete_task` uses.

Bound unconditionally into `buildTaskAgent` (`api/src/agents/chat-agent.ts:813-903`) alongside `complete_task` (currently line 849) — not added to `STATIC_CHAT_TOOLS`, since `ask_user` is shared with interactive chat but this tool is task-run-only, matching how `complete_task` itself is bound.

### 3.2 `api/src/agents/task-execution.ts`

In `runClaimed`'s post-stream branch (currently `completeTaskBox.current` → `interrupted` → stall at lines ~774-783):

1. Add a `handOffBox` ref/box next to `completeTaskBox`, wired through `makeHandOffTaskTool`'s `onAccepted`.
2. Insert a branch checking `handOffBox.current` between the existing `completeTaskBox.current` check and the `interrupted` check: set `finalOutcome = 'handed_off'`, call `store.setQueueEntrySummary(entry.id, handOffBox.current.summary)`, then `store.completeQueueEntry(entry.id, 'handed_off')`.
3. **Fix the Stalled Run branch** (the remaining `else`, and the `GraphRecursionError`/generic-failure paths in the `catch` block around lines 999-1018): use the agent's actual last plain-text message as the summary when it's non-empty, falling back to the existing canned message only when there's nothing usable. `finalOutcome` stays `'failed'` here — this branch is unchanged in outcome, only in what summary text it records.

`finalOutcome`'s type (`task-execution.ts:397`) gains `'handed_off'`.

### 3.3 `api/src/services/workspace-store.ts`

- `TaskQueueEntry['status']` (line 331) and the DB row union (line 473): add `'handed_off'`. Both columns are plain `TEXT` (migrations v20/v21) — **no schema migration needed**.
- `completeQueueEntry`'s `outcome` parameter type: add `'handed_off'`.
- `settleTaskAfterRun` (lines 2471-2510): in the ordinary (non-cohort, non-cron) branch that currently writes `tasks.status = outcome` verbatim (lines 2491-2493), special-case `'handed_off'` to write `'blocked'` instead — every other outcome keeps today's verbatim passthrough.
- `failedRunStreaks()` (lines 2154-2177): add `'handed_off'` to the `ranked` CTE's `status IN (...)` boundary set (currently `('done', 'failed', 'cancelled')`), so a Handed-Off Run correctly ends a failure streak without itself counting as a failure (it's excluded from the `WHERE ranked.status = 'failed'` final filter already, by construction).
- New method, name TBD at implementation (e.g. `handedOffRunCounts(taskIds)`): a plain count of `handed_off` runs per task, for the retrospective aggregator (§3.5) — no streak logic needed, unlike `failedRunStreaks`.

### 3.4 `api/src/agents/tools/task-run-transcript.ts`

Add `'handed_off'` to `FINISHED_RUN_STATUSES`, so `read_task_run` treats a Handed-Off Run as transcript-readable, the same mechanism that already let the follow-up run in the original incident resume cleanly.

### 3.5 `api/src/routes/v1/tasks.handlers.ts`

Add `'handed_off'` to `RunOutcome` and `RUN_OUTCOMES` (lines 133, 139), so a cron task's `lastRunOutcome` can report it.

### 3.6 `lib/workspace-reports/src/build.ts`

Alongside the existing `store.failedRunStreaks(...)` call (line 95) and its `repeated_failures` anomaly (lines 123-132) and `failureCount` aggregate (lines 149-157): add a parallel `handoffs` field (exact shape TBD at implementation) sourced from the new store method in §3.3, surfaced in the retrospective's structured output and narrative as its own line — not merged into `repeated_failures` or `failureCount`, and not counted toward either.

### 3.7 System prompt

Wherever the task agent's system prompt currently describes `complete_task`/`ask_user` (exact location to confirm at implementation time — likely `api/src/agents/system-prompt.ts` or inline in `buildTaskAgent`'s prompt assembly), add a description of `hand_off_task`: when to call it (the user has asked the Run to stop after an `ask_user` question) versus `complete_task` (the goal is actually met or un-meetable) versus continuing.

## 4. UI

No code changes needed. `ui/src/components/task-run-history.tsx:61` already renders `run.status` as raw text, and `ui/src/components/task-drawer.tsx`'s status-to-lane styling only switches on `Task.status`, which stays within its existing value set (§3.3's `blocked` mapping). Confirmed by reading both files directly rather than assumed.

## 5. Evaluation-Driven Development

This is LLM-facing behavior (the agent now has to choose between `complete_task`, `hand_off_task`, `ask_user`, or continuing) — per this repo's EDD rules (root `AGENTS.md`), a failing eval scenario is required before implementing the system-prompt/tool-choice change, covering at least: the agent calls `hand_off_task` (not `complete_task`, not a bare stall) after being told to stop following an `ask_user` interrupt. Suite placement TBD at implementation time.

## 6. Testing

- **`hand-off-task.tool.test.ts`** (new, `[unit]`): rejects the first call with `pauseReason !== 'chat'`; accepts the first call with `pauseReason === 'chat'`; accepts an immediate second call regardless; `onAccepted` fires only on an accepted call.
- **`task-execution.test.ts`** (extended, `[orchestration]`): an accepted `hand_off_task` call produces `finalOutcome: 'handed_off'`, persists the tool's own summary, and settles the Task to `blocked`. A genuine stall with a non-empty last agent message persists that text as the summary, not the canned message; a stall with no usable text still falls back to the canned message.
- **`workspace-store.test.ts`** (extended, `[unit]`): `failedRunStreaks()` treats a `handed_off` run as a streak boundary without counting it as a failure; `settleTaskAfterRun` writes `blocked` for a `handed_off` outcome and the verbatim outcome for every other case (regression check).
- **`build.test.ts`** (`lib/workspace-reports`, extended, `[unit]`): the new `handoffs` field reflects `handed_off` run counts and is absent/zero-valued when there are none; `repeated_failures`/`failureCount` are unaffected by a task with only `handed_off` runs.
- **E2E**: out of scope — no UI change (§4) and the tool-choice behavior itself is an eval concern (§5), not a Playwright concern.

## 7. Follow-up (separate issue, not this work)

File a GitHub issue to review the ROI of consolidating `TaskQueueEntry['status']`, `finalOutcome`, and `RunOutcome` into one shared run-outcome type, now that `'handed_off'` has been added to all three independently. Reference ADR-0054.

## 8. Acceptance Criteria (from #364)

- A Run that calls `hand_off_task` after an `ask_user` interrupt is recorded as `handed_off`, not `failed`, with its own summary preserved. §3.1, §3.2
- `handed_off` Runs are transcript-readable via `read_task_run`. §3.4
- `handed_off` Runs do not count toward a Task's failed-run streak or a workspace retrospective's failure count, but are visible in the retrospective as their own signal. §3.3, §3.6
- A genuine Stalled Run's real summary text, when it produced one, is preserved instead of overwritten by the canned message. §3.2
- No schema migration required. §3.3
