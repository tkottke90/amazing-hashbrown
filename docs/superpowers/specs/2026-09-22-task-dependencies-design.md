# Feature: task dependencies (gap #2 — stop tasks cascading into failure)

## Context

Gap #1 (letting a user answer a task's `waiting_on_user` HITL prompt from chat) shipped and merged. The user's original manual test surfaced a second, more structural gap: **without a dependency system, tasks cascade out of the Ready queue and fail immediately** — when a batch of tasks is created together (e.g. via the `create_tasks` chat tool) and one of them pauses on `waiting_on_user`, the _other_ tasks in that batch don't wait for it; they're already `ready`/enqueued and get dequeued and run (and typically fail) regardless of whether an earlier step in the same plan actually succeeded.

The user's own proposal: track dependencies via a DB join table between tasks, where a task with unmet dependencies cannot start until they're satisfied. They also flagged that "done" isn't a single concept — a dependency might require the target to have _succeeded_, or just to be _over_ (any terminal outcome), and a dependent might be allowed to proceed even if its target is merely paused (`blocked`), not fully finished.

This was brainstormed and refined through a full Q&A pass (see Design below for the decisions reached). Full research on the existing task/queue system (schema, `dequeueNext()` scope logic, terminal-state recording, migration mechanism, `create_tasks` tool, Kanban UI) was gathered via an Explore agent and is folded into the Design section's file/line references.

## Existing system (relevant facts gathered during research)

- `TaskStatus` = `'pending' | 'ready' | 'running' | 'waiting_on_user' | 'blocked' | 'done' | 'failed' | 'cancelled'` (`workspace-store.ts:90-91`). `tasks.id` is a TEXT UUID PK, not an integer.
- `task_queue` entry status is a _separate_, narrower enum: `'pending' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'` (`workspace-store.ts` `TaskQueueEntry`, ~174-185). Ordering is pure `position ASC`, FIFO.
- `dequeueNext()` (`workspace-store.ts:1205-1252`) claims the first pending queue row whose _scope_ (`workspace_id` or `'inbox'`) has no other non-`origin='agent'` task currently `running` — one non-agent task runs per scope at a time. It does not otherwise reason about ordering/priority.
- `completeQueueEntry(id, outcome: 'done'|'failed'|'cancelled')` (`workspace-store.ts:1254-1267`) mirrors `outcome` onto both `task_queue.status` and `tasks.status`. This is the single choke point for every terminal state.
- `blocked` = a _running_ task the user paused (`pauseTaskHandler` → abort → `parkQueueEntry`, `workspace-store.ts:1269-1286`, sets `task_queue.status='paused', pause_reason='user', paused_at=now` and `tasks.status='blocked'`). Resumed via the existing paused-queue-row (`resumePausedEntry`) or, for our new case, via `patchTask`.
- `waiting_on_user` = the agent hit an `ask_user` interrupt; resumed via `POST /:threadId/hitl`'s task-aware branch (`workspace-chat.route.ts:148-171`), which sets `status:'ready', assignedTo:'agent', resumeAnswer`, then `enqueueTask` + `wake()`.
- Migrations: a single flat, globally-versioned `MIGRATIONS: DbMigration[]` array in `workspace-store.ts` (current ledger comment at lines 352-368 tops out at version 30 — **31 is the next free version**, confirmed free repo-wide as of this writing, re-check before committing in case another branch claimed it meanwhile). `CREATE TABLE ... REFERENCES tasks(id)` is safe to add directly (unlike `ALTER TABLE ADD COLUMN ... REFERENCES`, which isn't, per the v23 comment).
- `create_tasks` tool (`api/src/agents/tools/create-tasks.tool.ts`) + `WorkspaceStore.createTasks()` (`workspace-store.ts:1160-1177`): one transaction, every task in the batch is immediately `createTask()` → `patchTask(status:'ready', assignedTo:'agent')` → `enqueueTask()`. This is the exact mechanism producing the bug — nothing here currently gates on anything.
- `deleteTask` (`workspace-store.ts:1091-1094`) is a bare `DELETE FROM tasks` with no cascade at all today (pre-existing gap, not introduced by this feature, but this feature's new table needs to be added to the cleanup regardless).
- Frontend: `ui/src/pages/workspaces/[id].tsx` (Kanban board, one column per `TaskStatus` except `cancelled` merged into `failed`), `ui/src/components/task-drawer.tsx` (single-task editor/action-panel). Neither has any existing concept of cross-task relationships to build on — this is greenfield UI.

## Decisions reached during brainstorming Q&A

1. **A required dependency that fails (or is cancelled) auto-moves the dependent to `blocked`** (not auto-cancel, not silently-stuck-pending) — reuses the existing pause/resume visual language and mechanism rather than inventing a new status.
2. **A dependency that's simply not finished yet** (the common case) leaves the dependent at `pending` (no new status), with a Kanban card badge ("Waiting on: `<title>`") for visibility.
3. **`whileBlocked: true`** means the target reaching `blocked` (human-paused) status _also_ satisfies that edge — not just reaching a terminal state.
4. **`requireSuccess: false`** is satisfied by _any_ terminal state (`done`/`failed`/`cancelled`) of the target — "I just need it to be over."
5. Dependencies are created **both** by the `create_tasks` agent tool (batch-scoped, index-based, simple defaults) **and** by a manual "depends on" picker in the Task Drawer (arbitrary existing tasks).
6. The manual picker only offers tasks in the **same workspace** (or inbox↔inbox) — matches the existing per-workspace scope model.
7. Dependencies are **only editable while the task is `pending`** — once `ready`/`running`/etc. the dependency list is locked. (The existing Take-over action is the escape hatch: it resets a `blocked`-by-dependency task back to `pending`, assigned to the human, at which point its dependencies become editable again. Reuses the existing mechanism; §5 below flags one existing code path that needs a small guard so it can't be used to bypass the gate instead.)

## Design

### 1. Schema

New migration, version 31 (re-verify still free before writing the code), in `workspace-store.ts`'s `MIGRATIONS` array — update the top-of-file ledger comment too:

```sql
CREATE TABLE IF NOT EXISTS task_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
  require_success INTEGER NOT NULL DEFAULT 1,
  while_blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, depends_on_task_id),
  CHECK(task_id != depends_on_task_id)
);
CREATE INDEX idx_task_dependencies_task_id ON task_dependencies(task_id);
CREATE INDEX idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id);
ALTER TABLE tasks ADD COLUMN blocked_reason TEXT;
```

`blocked_reason` (nullable, no FK — a plain `ALTER TABLE ADD COLUMN` is safe here, unlike a `REFERENCES` column) carries _why_ a task is `blocked`, distinct from and additional to the existing `task_queue.pause_reason`/`paused_at` (which only exist for a task that actually reached `running` and then got paused — a dependency-blocked task never got that far, so it has no queue row to carry a reason on). Set to `'dependency_failed'` by `releaseEligibleDependents` (§2) when a required dependency breaks; left `null` for a plain user-initiated pause (that case keeps using `task_queue.pause_reason='user'` exactly as today — this column is additive, not a replacement). Cleared back to `null` on any transition out of `blocked` (Take-over, or the existing Resume path), so a task that's been blocked more than once never shows a stale reason.

`taskId`/`dependsOnTaskId` (not the originally-proposed `source`/`target`) to read unambiguously at call sites, matching the existing `task_id` naming on `task_queue`. Two indexes: one to look up "what does this task depend on" (checked when deciding readiness), one for "what depends on this task" (checked when a task completes, to find who to re-evaluate). `UNIQUE`+`CHECK` prevent duplicate edges and self-dependency at the DB level.

Add corresponding `WorkspaceStore` methods: `addTaskDependency(taskId, dependsOnTaskId, { requireSuccess, whileBlocked })`, `removeTaskDependency(id)`, `listTaskDependencies(taskId)` (outgoing — what this task depends on), `listDependents(taskId)` (incoming — who depends on this task), following the existing method-per-operation style already used throughout this class (no generic "query builder").

### 2. Scheduler integration

Two new `WorkspaceStore` methods:

- **`isTaskReady(taskId): boolean`** — reads all `task_dependencies` rows where `task_id = ?`, joins each `depends_on_task_id` to its current `tasks.status`, returns true only if every row is satisfied:
  - `whileBlocked && target.status === 'blocked'` → satisfied
  - else if `requireSuccess` → satisfied only when `target.status === 'done'`
  - else → satisfied when `target.status` is any of `done`/`failed`/`cancelled`
- **`hasBrokenDependency(taskId): boolean`** — true if any `requireSuccess` edge's target is `failed` or `cancelled` — permanently unsatisfiable, since `whileBlocked` only ever rescues a target reaching `blocked`, never `failed`/`cancelled`.
- **`releaseEligibleDependents(changedTaskId): void`** — reads all `task_dependencies` rows where `depends_on_task_id = changedTaskId` (who was waiting on this task), and for each dependent still `status === 'pending'`:
  - if `hasBrokenDependency(dependentId)` → `patchTask(dependentId, { status: 'blocked', blockedReason: 'dependency_failed' })`
  - else if `isTaskReady(dependentId)` → `patchTask(dependentId, { status: 'ready', assignedTo: 'agent' })` + `enqueueTask(dependentId)`

Called from exactly two existing choke points (no new call sites scattered around):

- End of `completeQueueEntry(id, outcome)` (`workspace-store.ts:1254-1267`) — after mirroring `outcome` onto `tasks.status`, call `releaseEligibleDependents(taskId)`.
- End of `parkQueueEntry(id)` (`workspace-store.ts:1269-1286`) — after setting `tasks.status='blocked'`, also call `releaseEligibleDependents(taskId)` (only `whileBlocked` edges can be satisfied by this transition).

`dequeueNext()` itself needs **no change** — a task with unmet dependencies is simply never enqueued (stays `pending`, no `task_queue` row), so the existing scope-based dequeue logic is untouched.

### 3. `create_tasks` tool changes

**File:** `api/src/agents/tools/create-tasks.tool.ts` + `WorkspaceStore.createTasks()` (`workspace-store.ts:1160-1177`).

Add an optional `dependsOnIndexes?: number[]` field per task in the Zod schema's batch array — a zero-based index into that same `tasks` array, constrained (validated in the tool, rejected with a clear error otherwise) to only reference **earlier** indices in the same batch. That ordering constraint makes the batch trivially cycle-free without a graph traversal. Defaults baked in for this path: `requireSuccess: true, whileBlocked: false` — the tool doesn't expose those flags at all (YAGNI; per-edge tuning is a manual-UI-only feature, per the brainstorming decision above).

In `WorkspaceStore.createTasks()`: still one transaction. First insert all task rows (so real TEXT ids exist), then insert `task_dependencies` rows resolving indices to ids, then for each task: if it has zero dependency rows, `patchTask(ready/agent)` + `enqueueTask` exactly as today; if it has one or more, leave it at `createTask()`'s default `pending` — no patch, no enqueue.

### 4. Manual UI

**Task Drawer** (`ui/src/components/task-drawer.tsx`): a new "Depends on" section, visible only while `!isNew && task.status === 'pending'` (the "editable only while pending" decision). A searchable picker scoped to the task's own workspace (or inbox↔inbox), listing other tasks by title with `requireSuccess`/`whileBlocked` toggles, plus a list of currently-added dependencies with a remove button. Needs new backend endpoints (`POST`/`DELETE` on something like `/api/v1/tasks/:id/dependencies`) backed by `addTaskDependency`/`removeTaskDependency`/`listTaskDependencies` from §1, with cycle detection (see §5) run server-side before insert.

**Kanban card** (`ui/src/pages/workspaces/[id].tsx`): a small badge on a `pending` task with unmet dependencies — "Waiting on: `<dependency title>`" (first alphabetically if more than one, "+N more" beyond that) — needs the dependency list available in the tasks list response (likely a cheap extra join/query in `listTasks`, or a follow-up per-workspace fetch — decide at implementation time based on what's cheapest given `listTasks`' existing shape). For a `blocked` task, extend the existing pause/resume banner: if `task.blockedReason === 'dependency_failed'`, show "Blocked — a dependency failed" (plus a Take-over button, no Resume — there's no paused queue row to resume) instead of today's "Paused task controls" wording, which stays as-is for a plain user-initiated pause (`blockedReason === null`).

### 5. Cascade / edge cases

- **Escape hatch for a dependency-blocked task:** reuses the _existing_ Take-over action (`takeOverTaskHandler`, `status: 'pending', assignedTo: 'user'`) — once taken over, the task is back to `pending` with `blockedReason` cleared, so (per the editable-only-while-pending rule) its dependency list becomes editable again; the human can remove/replace the broken dependency or just finish the task manually. Verify `takeOverTaskHandler` doesn't currently reject a `blocked`-status task (research didn't confirm this explicitly) and extend its allowed-source-statuses if needed.
- **Closing a gate-bypass gap:** `patchTaskHandler`'s existing `blocked → ready` branch (`tasks.handlers.ts:120-135`) looks for a paused `task_queue` row and, per the research, _falls back to a bare `enqueueTask(id)` if none exists_ (today a defensive "data desync" case). A dependency-blocked task never had a queue row, so without a guard this fallback would let a direct `PATCH { status: 'ready' }` silently re-enqueue a task whose required dependency is still broken — bypassing the entire gate. Fix: that branch must check `blockedReason` first — if `'dependency_failed'`, reject the direct patch (require Take-over instead, which explicitly reassigns to the human) rather than falling back to enqueue.
- **Cycle detection:** required only for the manual-UI path (arbitrary graph) — a DFS from the _proposed_ `dependsOnTaskId`, checking whether it can already reach back to `taskId`, run server-side at insert time. Not needed for the `create_tasks` batch path (earlier-index-only constraint already prevents cycles there).
- **Deletion cascade:** `deleteTask` (`workspace-store.ts:1091-1094`) currently has no cascade at all (pre-existing gap). Add `task_dependencies` cleanup (`DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?`) to `deleteTask` and to `deleteWorkspace`'s existing manual-cascade transaction (`workspace-store.ts:723-737`).
- **Transitive chains:** no special-case logic — if C depends on B depends on A, and A fails, B cascades to `blocked` (a broken required edge) and C simply never becomes ready (B never reaches `done`); falls out of the same per-edge check with no extra cascade code.
- **Cross-workspace validation:** enforced server-side in the add-dependency endpoint (reject if the two tasks' `workspaceId`s differ, treating `null`/`null` as matching "inbox" scope) — not just a client-side picker filter.

## Testing

**Backend:**

- `workspace-store.test.ts`: new CRUD tests for `addTaskDependency`/`removeTaskDependency`/`listTaskDependencies`/`listDependents`, plus `isTaskReady`/`hasBrokenDependency`/`releaseEligibleDependents` covering all three flag combinations (`requireSuccess` true/false, `whileBlocked` true/false) and the cascade-to-`blocked` case.
- `create-tasks.tool.test.ts`: a batch with `dependsOnIndexes` — both the "dependent stays pending" case and the "no dependencies, auto-runs as today" case; rejection of a forward-referencing index.
- New test coverage for the manual dependency endpoints (`tasks.handlers.test.ts` or a new file, following this repo's existing route-test conventions) — add/remove, cycle rejection, cross-workspace rejection, editable-only-while-pending rejection.
- `workspace-store.test.ts` or `tasks.handlers.test.ts`: `deleteTask`/`deleteWorkspace` clean up `task_dependencies` rows.
- `tasks.handlers.test.ts`: regression case for the gate-bypass gap in §5 — a direct `PATCH { status: 'ready' }` on a task `blocked` with `blockedReason: 'dependency_failed'` is rejected, not silently re-enqueued; Take-over still works on the same task.

**Frontend:**

- `task-drawer.test.tsx`: the "Depends on" section renders only while `pending`; add/remove dependency calls the right endpoint; toggles for `requireSuccess`/`whileBlocked`.
- New or extended Kanban test: the "Waiting on: X" badge renders for a pending task with an unmet dependency; the blocked-reason copy renders for a dependency-caused `blocked` task.

**Out of scope, explicitly not built here:** any dependency visualization beyond a text badge (no graph/DAG diagram view), bulk dependency editing, changing dependencies on a non-`pending` task without going through Take-over first.

## Verification

1. `npm run lint && npx prettier --check . && npm test` from repo root (both `api` and `ui` suites) — all new and existing tests green.
2. Manual re-run: use `create_tasks` to create a 2-task batch where task 2 `dependsOnIndexes: [0]`, and make task 1 pause on `waiting_on_user` (reuse the `shell_exec` approval scenario from prior manual tests) — confirm task 2 stays `pending` with a "Waiting on: <task 1 title>" badge instead of immediately running/failing. Answer task 1's prompt, confirm it completes, then confirm task 2 automatically flips to `ready`/enqueues/runs. Separately: fail task 1 instead, confirm task 2 auto-moves to `blocked` with the dependency-failure reason shown, then Take-over task 2 and confirm its dependency list becomes editable again.
