# Feature: shared progress record for related tasks in a workspace (issue #302)

## Context

A task's only built-in continuity today is with *itself* — `buildRunKickoff` (`api/src/agents/task-context.ts`) automatically hands a new run its own previous run's summary, no tool call required. There is no equivalent for *related but distinct* tasks working the same feature or branch. The existing relational primitives (`task_dependencies`/`dependsOnTaskId`, `trackerType`/`trackerId` from `create_tasks`' `trackerUrl`) only ever carry a boolean/status signal — "did the related task finish, and did it succeed or fail" — never *what it actually did*. `get_task_outcome` can answer that, but only if the agent already knows a specific sibling task's exact id and chooses, unprompted, to ask; nothing proactively tells a new task that related tasks even exist.

In production this showed up as a concentrated failure: 6 tasks under the same tracker-linked feature (issue #250 — Docs, API, UI, AuthProvider refactor, error-path tests, docs+PR), each started cold with no visibility into what sibling tasks had already changed on the shared branch. Each burned most or all of its call budget re-deriving "what already exists here" via `git status`/`git log`/wiki lookups. All 7 flagged runs across a 47-run production sample were concentrated in this one tracker-linked cohort.

Full research on `task-context.ts`, `workspace-summarizer.ts`, `chat-agent.ts`, `complete_task`, the task data model, `get_task_outcome`, `create_tasks`, and `workspace-git.ts` was gathered via an Explore agent and is folded into the Design section's facts below. This was brainstormed and refined through a full Q&A pass with the repo owner (see Decisions below).

## Existing system (relevant facts gathered during research)

- **`buildRunKickoff`** (`api/src/agents/task-context.ts`) builds a plain human-turn kickoff message (not a system-prompt block). When there's a previous run of the *same* task, it appends that run's one-line `summary` plus a conditionally-bound `read_task_run` tool — bound only when a previous run exists, never described generically in the system prompt. This is the sanctioned pattern this feature extends.
- **`workspace-summarizer.ts`** writes `.hashbrown/summaries/<timestamp>.md` under `workspace.location` via a single-writer flow (one workspace chat turn at a time) — it is **not** built for concurrent writers, which matters because sibling tasks under one tracker can complete concurrently.
- **`complete_task` the tool** (`api/src/agents/tools/complete-task.tool.ts`) is a pure function — it validates the plan-checklist nudge and returns a string; it does **no** git capture and **no** file/DB writes itself.
- **`task-execution.ts`**'s `onTaskComplete` hook is the actual choke point: on completion it calls `store.setQueueEntrySummary(entry.id, summary)` and `store.completeQueueEntry(entry.id, outcome)` — the only two writes that currently happen, and the two things that must never be blocked by anything new added here.
- **Task data model** (`workspace-store.ts`): `trackerType`/`trackerId` are plain nullable columns on `tasks`, resolved once per `create_tasks` batch call (every task in one call shares the same tracker link — there's no per-task-link concept). `task_dependencies` is a real table (`taskId`, `dependsOnTaskId`, `requireSuccess`, `whileBlocked`) added in migration v31. `task_cohorts`/`cohortOf` (v38) is an unrelated concept — cron fan-out batch-settlement gating, not sibling grouping.
- **`get_task_outcome`** tool reads `store.listTaskRuns(taskId)` and formats the latest run's `summary` — this is the exact per-task data this feature reuses for the dependency side, just surfaced automatically instead of on-demand.
- **No git diff/log helpers exist anywhere.** `workspace-git.ts` has `getGitStatus`/`listBranches`/`fetchRemote`/`syncFastForward`/`pushBranch`/`checkoutBranch`/`createBranch`, all via `execFile('git', [...], { cwd: location })`; read-only calls take no lock, mutating ones use `withLock(workspaceId, fn)`. No `diff`/`log` helper is present — new code.
- **No multi-repo-per-workspace layout exists.** A `Workspace` is one directory (`workspace.location`); there is no `/app/config/projects/<workspace>/<repo>` nesting anywhere in the codebase, contrary to an assumption in the original issue's developer notes.
- **No FK enforcement.** SQLite's `REFERENCES` constraints are inert here — `PRAGMA foreign_keys = ON` is never set repo-wide. The existing convention (`task_dependencies`, `task_cohorts`) is manual application-level cleanup inside `deleteTask`/`deleteWorkspace`, each wrapped in its own transaction — not a DB cascade.
- Migrations are a single flat `MIGRATIONS: DbMigration[]` array in `workspace-store.ts`; highest version currently in the ledger is **41** → next free version is **42** (re-verify still free before committing, per existing convention noted in prior specs).

## Decisions reached during brainstorming Q&A

1. **"Related" is the union of two independent mechanisms**, not one generic grouping concept: tasks sharing a `trackerType`+`trackerId` (the tracker-linked cohort case from production), **and** tasks connected via `task_dependencies` even with no tracker at all. These are kept as two separate code paths with different storage, not merged into one bag.
2. **Dependency reach is direct edges only** — no transitive graph walk. Matches how `task_dependencies` is used everywhere else in the codebase (no existing transitive-walk helper), and keeps kickoff context bounded.
3. **Touched-files capture is both harness-derived and model-authored**: the harness computes the authoritative file list + commit SHA(s) via new git helpers; the model's existing `complete_task` `summary` argument supplies the natural-language narrative. Matches the original issue's own developer notes almost exactly.
4. **Scope is single-repo-per-workspace**, matching what exists today. A `repoIdentifier` field is still recorded on each entry for forward compatibility, but no multi-repo discovery/traversal is built — that's unscoped, separate future work if ever needed.
5. **Progress entries are an append-only structured log**, not an LLM-regenerated rolling narrative — each task completion appends one row; nothing is ever rewritten or summarized away. Pure harness-side write, no extra model call.
6. **Storage is a new DB table**, not a `.hashbrown` file. The literal `.hashbrown`-file precedent (`workspace-summarizer.ts`) is single-writer; this feature's production motivation is explicitly *concurrent* sibling-task completions under one tracker, which a shared file would need new locking infrastructure to handle safely. SQLite transactions get that for free.
7. **Cleanup on deletion**: a task's own progress entry **survives** that individual task being deleted (the whole point is a durable record independent of any one task's lifecycle — hence the denormalized `taskTitle`). A **workspace** being deleted **does** clean up its progress entries (genuine orphaning otherwise, no path back) — added to `deleteWorkspace`'s existing manual-cascade transaction.
8. **Delivery is auto-injection into the existing kickoff message**, not a new tool. A tool the model has to remember to call reproduces exactly the failure mode this issue exists to close (the same way `update_plan` being optional caused the original problem). No new tool is introduced.

## Design

### 1. Schema

New migration, version 42 (re-verify still free before committing) in `workspace-store.ts`'s `MIGRATIONS` array — update the top-of-file ledger comment too:

```sql
CREATE TABLE IF NOT EXISTS task_progress_entries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tracker_type      TEXT NOT NULL,
  tracker_id        TEXT NOT NULL,
  task_id           TEXT NOT NULL REFERENCES tasks(id),
  task_title        TEXT NOT NULL,       -- denormalized: survives task edits/deletion
  workspace_id      TEXT NOT NULL,
  repo_identifier   TEXT NOT NULL,       -- workspace.remoteUrl, else basename(workspace.location)
  start_commit_sha  TEXT,                -- HEAD at run start; null if repo had no commits yet
  end_commit_sha    TEXT,                -- HEAD at run completion
  commit_shas       TEXT NOT NULL,       -- JSON string[] of commits made during the run
  files_changed     TEXT NOT NULL,       -- JSON string[] from `git diff --name-only` (or status if uncommitted)
  plan_snapshot     TEXT,                -- JSON PlanStep[] (reuses existing type), nullable
  outcome           TEXT NOT NULL,       -- 'done' | 'failed'
  summary           TEXT NOT NULL,       -- the model's complete_task summary (prose)
  completed_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_progress_tracker
  ON task_progress_entries(tracker_type, tracker_id);
```

Corresponding `TaskProgressEntry` TS interface in `workspace-store.ts`, camelCase fields, JSON-serialize-on-write/parse-on-read for the array/object fields (same pattern already used for `tasks.plan`).

New `WorkspaceStore` methods, following the existing method-per-operation style (no generic query builder):

- `insertTaskProgressEntry(entry: NewTaskProgressEntry): void`
- `listTaskProgressEntries(trackerType: string, trackerId: string, excludeTaskId?: string): TaskProgressEntry[]` — newest first
- `deleteTaskProgressEntriesForWorkspace(workspaceId: string): void` — called from `deleteWorkspace`'s existing manual-cascade transaction (alongside its existing `tasks`/`task_dependencies` cleanup). **Not** called from `deleteTask` — individual-task deletion intentionally leaves progress entries in place (Decision 7).

### 2. New git helpers (`workspace-git.ts`)

Read-only, same `execFile('git', [...], { cwd: location, timeout })` pattern as the existing `getGitStatus`/`listBranches` — no `withLock` needed (read-only, same category as those two):

```ts
async function getHeadCommit(location: string): Promise<string | null>
// git rev-parse HEAD — null on an unborn HEAD (no commits yet)

async function getChangedFiles(location: string, fromSha: string | null, toSha: string): Promise<string[]>
// fromSha === null → git ls-files (first-commit case)
// else → git diff --name-only <fromSha> <toSha>

async function getCommitsBetween(location: string, fromSha: string | null, toSha: string): Promise<string[]>
// fromSha === null → [toSha]
// else → git log --format=%H <fromSha>..<toSha>
```

### 3. Write path — `TaskProgressService` (new file, `api/src/services/task-progress.ts`)

Single-owner service for this feature's cross-cutting concern, matching the existing convention of `board-rules.ts`/`cron-settlement.ts` each owning one concern.

```ts
async function recordTaskProgress(params: {
  task: Task;
  workspace: Workspace;
  outcome: 'done' | 'failed';
  summary: string;
  startSha: string | null;
}): Promise<void>
```

Behavior:
1. No-op if `!task.trackerType || !task.trackerId` — a task with no tracker link has nothing to record.
2. `endSha = await getHeadCommit(workspace.location)`.
3. `commitShas`/`filesChanged` via the helpers above. If `startSha === endSha` (no commits made this run), `commitShas = []` and `filesChanged` falls back to `git status --porcelain` output, so uncommitted-only work still gets recorded.
4. `repoIdentifier = workspace.remoteUrl ?? path.basename(workspace.location)`.
5. `planSnapshot = task.plan` (already on the `Task` row — no extra fetch).
6. `store.insertTaskProgressEntry({ ...task-derived fields, ...computed fields })`.
7. **All failures here (git errors, DB errors) are caught and logged, never thrown.** A progress-recording failure must not fail the task's own completion, which is already settled by the time this runs.

**`task-execution.ts` integration:**
- At the top of the run function (before the model starts), capture `const startSha = await getHeadCommit(workspace.location);` into the same closure already holding `completeTaskBox`.
- In the existing completion branch — where `store.setQueueEntrySummary`/`store.completeQueueEntry` already run — additionally call `await taskProgressService.recordTaskProgress({ task, workspace, outcome, summary, startSha })`. This is a new, best-effort addition alongside the two existing required writes, not a replacement for them.

### 4. Read path — `getGroupContext` + `buildRunKickoff`

```ts
interface SiblingProgressContext {
  trackerEntries: TaskProgressEntry[];
  dependsOnSummaries: { taskId: string; title: string; status: TaskStatus; summary: string | null }[];
  dependedOnByTasks: { taskId: string; title: string; status: TaskStatus }[];
}

function getGroupContext(task: Task): SiblingProgressContext | null
```

- `trackerEntries`: populated only when `task.trackerType && task.trackerId`; `store.listTaskProgressEntries(trackerType, trackerId, task.id)`.
- `dependsOnSummaries`: for each `task_dependencies` row where `task_id = task.id`, the target's latest run via `store.listTaskRuns(dependsOnTaskId)` — same call `get_task_outcome` already makes, just surfaced automatically.
- `dependedOnByTasks`: `task_dependencies` rows where `depends_on_task_id = task.id` — title/status only, no outcome (they haven't run yet).
- Returns `null` if all three are empty — a task with no relationships gets no new kickoff content, unchanged from today.
- Any error inside this function (malformed stored JSON, store exception) is caught at the kickoff call site, logged, and treated as `null` — a task must never fail to start because this lookup broke.

**`buildRunKickoff` changes** (`task-context.ts`): new optional `siblingContext?: SiblingProgressContext | null` on `RunKickoffInput`. When non-null, appends a new block after the existing previous-run block, in the same register:

```
Related work on this feature (tracker: github#250):
- "API refactor" (done, 2026-10-14T...) — repo myrepo, commits a1b2c3d — touched api/src/auth/*, api/src/routes/auth.route.ts
  "Refactored AuthProvider to support token refresh; see AUTH-MIGRATION.md for the new interface."
- "UI auth screens" (done, 2026-10-14T...) — touched ui/src/components/Login.tsx
  "Wired the new refresh flow into the login screen; no visual changes."

Depends on:
- "Database migration" (done) — "Added refresh_token column, backfilled existing rows."

Expected to run after this task:
- "Error-path tests"
- "Docs + PR"
```

`trackerEntries` are capped the same way `previousRuns` already is (reusing the existing `EARLIER_RUNS_SHOWN`-style constant): full detail for the most recent N, a terse id/title list for anything older — mirrors the existing truncation and the `latestSummary`/`olderSummaries` precedent in `chat-agent.ts`, so a long-running tracker group never floods kickoff context.

Delivered as part of the existing human kickoff **message**, not a system-prompt block — same mechanism as today's previous-run summary. No new tool is introduced (Decision 8); this is pure auto-injection.

### 5. Error handling

- **Git capture failures** (detached HEAD, mid-rebase, missing `git` binary, timeout): caught in `recordTaskProgress`, logged, entry still written with the git-derived fields `null`/`[]` — a degraded entry beats losing the record.
- **Store write failures**: caught, logged, task completion proceeds unaffected — this write is additive to, not required by, the two existing completion writes.
- **Read-side failures**: caught at the kickoff call site, degrades to `null` context (today's behavior).
- **Stale group membership**: if `trackerType`/`trackerId` change after some siblings already completed, `getGroupContext` just queries current values at kickoff time — no backfill needed.

## Testing

**Backend:**

- `workspace-git.test.ts`: new `getHeadCommit`/`getChangedFiles`/`getCommitsBetween` — stub `execFile`; cover unborn-HEAD, normal diff, and a failing/timeout git call.
- `task-progress.test.ts` (new): `recordTaskProgress`/`getGroupContext` — stub store + git helpers; cover tracker-linked vs. untracked tasks, dependency-only tasks (no tracker), empty-group tasks, and every error path above degrading gracefully rather than throwing.
- `workspace-store.test.ts`: CRUD for `insertTaskProgressEntry`/`listTaskProgressEntries`; `deleteWorkspace` cleans up `task_progress_entries`; `deleteTask` does **not** (regression test for Decision 7's survive/cleanup split) — real in-memory SQLite, matching how `task_dependencies` is already tested.
- `task-execution.test.ts`: spy on `TaskProgressService.recordTaskProgress` — called with the right task/outcome/summary when `trackerType`/`trackerId` are set; not called when they aren't.
- `task-context.test.ts`: `buildRunKickoff`'s new block — given a constructed `SiblingProgressContext`, assert formatted content for tracker entries, depends-on summaries, the after-list, and truncation past the cap — same style as the existing previous-run tests.

**Frontend:** none — this is entirely a backend/agent-context concern, no UI surface changes.

**Out of scope, explicitly not built here:** multi-repo-per-workspace discovery/traversal (Decision 4), transitive dependency-graph walking (Decision 2), any UI surface for viewing progress entries, LLM-regenerated/consolidated summaries of the progress log (Decision 5).
