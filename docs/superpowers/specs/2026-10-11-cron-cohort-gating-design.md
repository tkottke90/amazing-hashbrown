# Feature: cron cohort gating — hold a cron task's reschedule until its spawned batch settles

## Context

The user wants to run an "orchestrator" cron task — e.g. a wiki-management task
that reviews every wiki in a workspace and, instead of doing all the work
itself in one long turn, fans out into one one-off lint/fix task per wiki via
the existing `create_tasks` tool. Other motivating examples: a dependabot-alert
monitor that creates one remediation task per affected package in a mono-repo,
or a daily newsletter job that reads several sources in parallel sub-tasks.

The concrete problem being solved (confirmed during brainstorming, not the
board-accuracy problem which was explicitly deprioritized): **preventing
duplicate/overlapping dispatch**. Today, a cron task's reschedule
(`settleCronRun()`) runs the instant its own dispatch turn ends, with zero
knowledge of anything it just spawned. If an orchestrator's cadence is shorter
than the time its spawned batch takes to finish, it fires again and creates a
second, fully redundant batch (e.g. a fresh lint task for every wiki, including
the ones whose lint task from the previous firing hasn't even started yet).

This was fully scoped through a brainstorming Q&A pass; the decisions below
reflect that conversation. Research on the existing task/cron/queue system was
gathered via an Explore agent in an earlier turn and re-verified directly
against the current source for this doc's file/line references.

## Existing system (relevant facts)

- `TaskStatus` includes `'blocked'` with a separate `blockedReason: 'dependency_failed' | null` column (`workspace-store.ts:155-159` for the type, `ALTER TABLE tasks ADD COLUMN blocked_reason TEXT` from the v31 migration). `blocked_dependency_failed` and `blocked_paused` (the existing two `blockedReason` buckets) both map to the `attention` Kanban lane (`board-rules.ts:178-191`).
- `create_tasks` (`api/src/agents/tools/create-tasks.tool.ts`) lets a running task's own agent spawn a batch of one-off tasks mid-turn — already usable from a cron task's own run, since a firing cron task is executed through the same task-agent build as any other task.
- `completeQueueEntry(id, outcome)` (`workspace-store.ts:1869-1879`) is the single choke point for every run's end; it immediately calls the private `settleTaskAfterRun(taskId, source, outcome, now)` (`workspace-store.ts:1885-1910`), which for a cron-triggered task calls `settleCronRun()` (`cron-settlement.ts:38-72`) — pure arithmetic over `{type, config, source, outcome, iterationCount, now}` — and writes the resulting `status`/`triggerConfig` back immediately. `iterationCount` is read live via `countScheduledRuns(taskId)` (`workspace-store.ts:1677`), not stored anywhere — it does not need to be frozen for a deferred settlement either.
- `fireCronTask()` (`workspace-store.ts:1918-1935`) only fires when `task.status === 'scheduled'` and the trigger is enabled — this existing "skip if not idle" gate is what already prevents overlapping _runs_ today, and (per the Design below) is also what will prevent a fire attempt while a task is held for its cohort, with no changes needed.
- `task_dependencies` (added in the `2026-09-22-task-dependencies-design.md` feature) is the only existing task-relationship primitive. It gates the _opposite_ direction — a _dependent_ task's `pending → ready` transition — via `isTaskReady()`/`isEdgeSatisfied()` (`workspace-store.ts:1443-1452`) and `releaseEligibleDependents()` (`workspace-store.ts:1470-1500`), called from `settleTaskAfterRun()`'s tail (line 1909) and from `parkQueueEntry()`. A `cron_repeat` task is explicitly rejected as a dependency _target_ (`tasks.handlers.ts:564-566`) because it "never finishes in the usual sense." None of this gates a task's own post-run settlement, which is the direction this feature needs — reusing this table would mean bypassing invariants it was deliberately built with, for no reuse benefit (see Design §1).
- **Found while tracing settlement, not previously documented:** `isEdgeSatisfied()` (`workspace-store.ts:1443-1447`) only checks `targetStatus === 'blocked'` for a `whileBlocked` edge — it has no visibility into `blockedReason`. This matters here: if some other task holds a `whileBlocked: true` dependency on a cron task that becomes this feature's new cohort-holder, that dependency would incorrectly release the moment the holder enters the new `blocked`/`awaiting_children` state, long before its children are done. This is a real pre-existing gap this feature's new `blockedReason` value walks straight into — fixed in Design §4.
- Migrations: a single flat `MIGRATIONS: DbMigration[]` array (`workspace-store.ts:493-691`), currently topping out at `version: 36` — **37 is the next free version** (re-verify before implementing). A `REFERENCES` column added via bare `ALTER TABLE ... ADD COLUMN` is unsafe in this codebase (noted at the existing version-23 comment); a `REFERENCES` column is only ever added via `CREATE TABLE`. `blocked_reason` itself shows the safe pattern for an unconstrained column: plain `ALTER TABLE tasks ADD COLUMN blocked_reason TEXT` with no FK.

## Decisions reached during brainstorming Q&A

1. **Problem being solved:** preventing duplicate/overlapping dispatch, not board-accuracy for its own sake (though the board still needs to render the new state sensibly — see §5).
2. **Opt-in, not automatic:** a cron task must explicitly ask for this via a new `asCohort` flag on its `create_tasks` call. Most cron tasks don't fan out and shouldn't pay for this.
3. **Outcome-blind release:** the cohort resolves once every child reaches _any_ terminal state (`done`/`failed`/`cancelled`) — a failed child doesn't block or specially flag the orchestrator's reschedule.
4. **No drift on release:** if the cron's scheduled fire time arrives while the cohort is still open, that fire is simply skipped (via the existing idle-gate, no new code). Once released, the next fire is computed fresh from the real cron expression — the cadence itself never moves, so this behaves exactly like the existing boot-time catch-up logic, not like "last-completion-plus-interval" drift.
5. **No nesting, structurally enforced:** a task is either a cohort _holder_ or a cohort _member_, never both. A `create_tasks(asCohort: true)` call from a task that already has `cohortOf` set is rejected outright — there is no depth tracking to get wrong, because the structure can't form in the first place.
6. **One cohort per holder, enforced by the same check:** a second `create_tasks(asCohort: true)` call within the same run is rejected by the identical "do I already hold an open cohort" check used for the no-nesting rule — no separate "already dispatched" bookkeeping.
7. **Board treatment:** reuse the existing `blocked` status with a new `blockedReason`, rather than adding a new `TaskStatus` value — cheaper, and the existing `blockedReason` column already exists for exactly this kind of "why" annotation.

## Design

### 1. Why not reuse `task_dependencies`

Considered and rejected. `task_dependencies` gates a _dependent_ task's own `pending → ready` transition based on _another_ task's state — the direction this feature needs is a task gating its _own_ post-run settlement based on tasks _it_ just spawned. Forcing this through the existing table would require: (a) a "holder mode" nobody else uses, since every current edge means "I'm waiting to start," not "I'm waiting to re-settle"; (b) bypassing the pending-only edge-creation guard (`tasks.handlers.ts:572-574`), since the holder is `running`, not `pending`, at the exact moment it would need to attach the edge; (c) carrying `requireSuccess`/`whileBlocked` semantics this feature explicitly doesn't need (decision 3 above — release is outcome-blind). None of that is reuse; it's bolting a second meaning onto a table whose existing guards were deliberately built to exclude it.

### 2. Schema

New migration, version 37 (re-verify still free before implementing):

```sql
CREATE TABLE IF NOT EXISTS task_cohorts (
  holder_task_id  TEXT PRIMARY KEY REFERENCES tasks(id),
  total_count     INTEGER NOT NULL,
  settled_count   INTEGER NOT NULL DEFAULT 0,
  pending_outcome TEXT,           -- JSON: {outcome, source}, NULL until the
                                   -- holder's own run closes (see below) —
                                   -- the row is created before that's known
  created_at      TEXT NOT NULL
);
ALTER TABLE tasks ADD COLUMN cohort_of TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_cohort_of ON tasks(cohort_of);
```

One row per _open_ cohort, keyed by the holder's own task id (a holder can only have one open cohort at a time — decision 6 — so no separate group-id is needed, unlike `dispatchGroupId`'s multi-group support for `spawn_sub_agent` siblings). The row is deleted the instant the cohort resolves, so "does task X hold an open cohort" is a single indexed lookup, not a status flag that can go stale.

`pending_outcome` is nullable because of a real ordering constraint, not sloppiness: the row is inserted by `create_tasks` while the holder is still mid-run (so `total_count` is known immediately), but the holder's own outcome isn't known until its run closes, some tool calls later. That ordering is also why there's no race to guard against on the other end: the holder's children share its scope, and `dequeueNext()`'s existing single-concurrency-per-scope rule (`workspace-store.ts:1813-1867`) means none of them can even start running until the holder's own queue entry closes — which is exactly when `pending_outcome` gets frozen. So `settled_count` can never reach `total_count` while `pending_outcome` is still `null`; this falls out of the existing scheduler invariant for free.

`tasks.cohort_of` is a plain, unconstrained `TEXT` column (no `REFERENCES` — per the ALTER-TABLE-with-FK hazard noted above), set on a child at creation time and never changed after. `blockedReason`'s TypeScript union widens to `'dependency_failed' | 'awaiting_children' | null` — no migration needed, the column already stores arbitrary text.

New `WorkspaceStore` methods, matching the existing method-per-operation style: `openCohort(holderId, totalCount)` (inserts the row, `pending_outcome` null), `getOpenCohort(holderId)`, `freezeCohortOutcome(holderId, outcome, source)` (called once, from the holder's own settlement), `settleCohortMember(holderId): { resolved: boolean; pendingOutcome }` (increments `settled_count`; if it now equals `total_count`, deletes the row and returns the frozen outcome for the caller to apply).

### 3. Settlement flow

Today, `completeQueueEntry()` → `settleTaskAfterRun()` (`workspace-store.ts:1885-1910`) does, for a cron task: compute `settleCronRun()`, write the result, call `releaseEligibleDependents()`. This logic is extracted into a small private helper, `applyCronSettlement(taskId, source, outcome, now)`, with no behavior change for the non-cohort case — it's called from exactly the two places below instead of being duplicated.

**When a holder's own run ends** (`settleTaskAfterRun`, before it would otherwise call `applyCronSettlement`): check `getOpenCohort(taskId)`. If found — this is a holder whose `create_tasks(asCohort: true)` call just ran in this same turn — call `freezeCohortOutcome(taskId, outcome, source)`, patch the task to `status: 'blocked', blockedReason: 'awaiting_children'`, and **return early**: do not call `applyCronSettlement` (so no `settleCronRun`, no `releaseEligibleDependents`) yet. If no open cohort, behavior is unchanged.

**When any child completes** (same `completeQueueEntry`, after the existing status write): if the completing task has `cohort_of` set, call `settleCohortMember(cohortOf)`. If it reports `resolved: true`, call `applyCronSettlement(holderId, pendingOutcome.source, pendingOutcome.outcome, now)` for the holder using `now` as _this_ moment — not the moment the holder's own run ended — and then `getCronRegistry().sync(holderId)` (the same call `withCronResync` already makes after every normal run) to arm the real timer. Because `nextFireAt()` always computes the next cron-expression occurrence strictly after whatever `now` it's given, this reschedule naturally lands on the correct future tick without drift or replay — decision 4 falls out of this for free.

**Collision with a scheduled fire while held:** no new code. The holder's status is `blocked`, not `scheduled`, so `fireCronTask()`'s existing gate (`workspace-store.ts:1925`) already skips any fire attempt, identically to how it already skips one during a normal run.

**Config changes while held:** `applyCronSettlement` reads the holder's _current_ `triggerConfig` at resolution time (not a frozen copy), so if the user disables the schedule while a cohort is open, `settleCronRun()` naturally returns `pending` instead of `scheduled` — no special-casing needed.

### 4. `create_tasks` tool changes

New optional batch-level parameter: `asCohort?: boolean` (applies to the whole call — one cohort per batch, matching decision 6). Validation, each a distinct rejection back to the agent:

1. The calling task's `triggerType` must be `cron_once` or `cron_repeat`. (A non-cron task asking to wait on its own batch before finishing is a different, explicitly out-of-scope feature.)
2. The calling task's `cohort_of` must be `null` (decision 5 — no nesting).
3. `getOpenCohort(callingTaskId)` must return no row (decision 6 — one cohort per run; this is the same check used for both the no-nesting rule and the one-cohort-per-run rule).

On success: create the N children exactly as `create_tasks` does today, tag each with `cohort_of: <holderId>`, and call `openCohort(holderId, N)`.

**Required fix to an existing function, found during this design (see Existing system above):** `isEdgeSatisfied()` (`workspace-store.ts:1443-1447`) must stop treating `blockedReason: 'awaiting_children'` as satisfying a `whileBlocked` dependency edge — that semantic was built for a human-paused task, not a task mid-cohort. Thread `blockedReason` through `loadDependencyEdges()`'s existing query (add `tasks.blocked_reason AS target_blocked_reason` to the `SELECT`) and change the check to `dep.whileBlocked && targetStatus === 'blocked' && targetBlockedReason !== 'awaiting_children'`.

### 5. Board / UI treatment

New `Source` value in `board-rules.ts`: `blocked_awaiting_children`, distinguished from `blocked_dependency_failed`/`blocked_paused` in `sourceOf()`'s existing `case 'blocked':` branch (`board-rules.ts:156-159`) by checking `blockedReason === 'awaiting_children'`.

- **Lane:** `scheduled`, not `attention` — add `blocked_awaiting_children: 'scheduled'` to `LANE_OF` (`board-rules.ts:178-191`). This is routine, expected waiting, not something broken.
- **Reason card:** new `BoardReason` kind, e.g. `{ kind: 'awaiting_children'; settled: number; total: number }`, read off the task's `task_cohorts` row (while open) so the card can show "3 of 7 done" rather than a bare label.
- **Moves:** only `→ backlog` is allowed from this source (same `disable_trigger` step `scheduled → backlog` already uses). Every other move is rejected with an explicit message. Deliberately **not** allowing a manual `→ done`: forcing the holder closed while children are still live would orphan the `task_cohorts` row and the still-running children's `cohort_of` reference. That's a real gap, but building cleanup for a self-inflicted orphan isn't worth it until someone actually needs to force-close an orchestrator mid-batch.

### 6. Explicitly out of scope

Carried over from the brainstorming scope discussion, restated here so the spec doesn't silently grow:

- Multi-level cohorts (a child that is itself a holder) — structurally prevented, not just undesigned (decision 5).
- Any `requireSuccess`/partial-failure threshold on release — decision 3 made this outcome-blind.
- Generalizing to non-cron tasks or to `spawn_sub_agent` — scoped to a `create_tasks` batch from a cron-triggered run only.
- A generic self-park-and-resume run state ("Parked Task Runs"-style) — not needed; the holder's own run still ends normally the instant it finishes dispatching. Only the _post-run settlement_ is deferred.
- Cleanup of an orphaned cohort from a force-deleted or force-closed holder — flagged in §5, not built.

## Testing

Following the repo's existing conventions (Mocha/Chai, unit → orchestration, adjacent test files):

- **Unit** (`create-tasks.tool.test.ts`): the three `asCohort` rejections (non-cron caller, already-a-child, already-holds-an-open-cohort).
- **Orchestration** (`workspace-store.test.ts`, against the real sqlite-backed store, matching its existing style):
  - Holder path: a cohort-opening run's completion freezes `pending_outcome` and flips the task to `blocked`/`awaiting_children` without touching `triggerConfig`/`status` via `settleCronRun`.
  - Member path: each child's completion increments `settled_count`; the last one deletes the `task_cohorts` row, applies the frozen settlement with the _current_ `now`, and calls through to `cronRegistry.sync` (spy).
  - The `isEdgeSatisfied()` fix: a `whileBlocked` dependency on a task that is `blocked`/`awaiting_children` does **not** release; the same dependency on a plain `blocked`/`null` (human pause) still does.
  - `fireCronTask()` skips a fire attempt while the holder is `blocked`/`awaiting_children` (same assertion style as the existing "skip while running" test, extended to this status).
- **`board-rules.test.ts`**: new cases for `blocked_awaiting_children`'s lane, its reason card, and its restricted move table (only `→ backlog` succeeds).
- **E2E (`@smoke`)**: a task fixture with `blockedReason: 'awaiting_children'` renders in the `scheduled` lane with the "N of M" badge — mocked at the API-fixture level, no live cron run needed.
- **E2E — new `@llm @local` suite:** sibling to `e2e/tests/workspace/CreateTasks.ts`, same `@tkottke90/playwrite-test-runner` pattern (manual, real dev server, real LLM, never run via `npm run test:e2e*` — see `e2e/AGENTS.md`'s "Manual test suites" section). One chat message creates a `cron_once` task (fires a few seconds out) whose own instructions tell it, on firing, to call `create_tasks` with exactly 2 simple children and `asCohort: true`. The test:
  1. Sends the chat message; waits (bounded polling, not a fixed sleep) for the real `CronRegistry` to fire the task and the real model to actually call `create_tasks(asCohort: true)` with 2 children — this is the one thing no mock can stand in for: whether a real model, given the instruction, reaches for this tool correctly.
  2. Asserts the orchestrator's card shows `blocked`/`awaiting_children` in the `scheduled` lane with a "0 of 2" badge, and both children appear in the `queue` lane.
  3. Asserts the two children run **one at a time, in the order created** — the second doesn't start until the first reaches `done` — the direct end-to-end proof that cohort children are ordinary one-off tasks sharing the existing per-scope single-concurrency rule, not something new.
  4. After the second child reaches `done`, asserts the orchestrator's card flips back to `scheduled` with a real next-fire time shown — the end-to-end proof of the full dispatch → hold → release pipeline under real wall-clock timing, not just the deterministic store logic the orchestration tests above already cover.

## Verification

1. `npm run lint && npx prettier --check . && npm test` from repo root — all new and existing tests green.
2. Manual re-run: create a `cron_once` task (fires in ~1 minute) whose agent, on firing, calls `create_tasks` with 3 children and `asCohort: true`. Confirm the orchestrator shows `blocked`/`awaiting_children` in the `scheduled` lane with a "0 of 3" badge immediately after dispatch. Complete the three children one at a time (two `done`, one `failed`, to confirm decision 3's outcome-blind release); confirm the orchestrator settles to `done` (a `cron_once` task's terminal state) only after the third, and that the `task_cohorts` row is gone. Repeat with a `cron_repeat` task on a short interval and confirm it goes back to `scheduled` with the correct next fire time computed from `now` at release, not from when the original run ended.
