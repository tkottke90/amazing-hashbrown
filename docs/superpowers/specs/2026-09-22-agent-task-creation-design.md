# Agent Task Creation — Breaking Approved Plans into Queued Tasks — Design

**Date:** 2026-09-22
**Status:** Draft
**Related:** N/A — no tracking issue filed yet. First of four specs decomposed from a broader gap analysis of the workspace/task system (create-task tool, script trust policy, completion verification, dependency ordering) — this spec covers the first only.

---

## Goal

Let the agent turn an approved plan into queued, autonomously-executing work itself, from within workspace chat — instead of task creation being a human-only action through the REST API/Task Drawer UI. Concretely: after a user and the agent brainstorm a solution to a GitHub issue (or any workspace goal) and the user approves it, the agent should be able to break that approved plan into a batch of `Task` rows and have them run, one after another, without the user re-prompting between them or manually creating each task by hand.

---

## Problem

`POST /api/v1/workspaces/:id/tasks` (via `createTaskHandler`) is reachable only from the UI's Task Drawer form. Nothing in `STATIC_CHAT_TOOLS` (`chat-agent.ts`) lets the chat agent create a task itself. The closest existing mechanism, `spawn_sub_agent`, is structurally the wrong shape for this: it's read-only, role-locked to a fixed provider/model, cannot nest, and is meant for bounded research delegation — not "go implement this phase of the issue."

This means that even when a user and the agent fully agree on a plan in workspace chat, turning that plan into queued, autonomous work requires the user to leave the conversation and manually create each task through the UI. The scheduler, HITL pause/resume, per-workspace serialization, and GitHub-tracker linkage (`tracker-github.ts`, `Task.trackerType`/`trackerId`) already exist and work — the only missing piece is exposing task creation as something the agent can do.

---

## Scope

**In scope:**

- A new `create_tasks` tool, callable from workspace chat, that creates a batch of `Task` rows in one call.
- Linking the created batch to a GitHub issue/PR by URL, reusing the existing tracker-adapter infrastructure.
- Fine-grained, single-task checklists via the existing `Task.plan: PlanStep[]` field, exposed as an optional per-task input.

**Out of scope (deferred to their own specs):**

- **Script trust policy** — this spec does not change `shell_exec`'s approval behavior. Tasks created by this tool still pause to `waiting_on_user` on any non-allowlisted shell command, same as today.
- **Completion verification** — `complete_task` remains a self-report (`done`/`failed` + summary); this spec does not add any check that a task's claimed outcome is real.
- **Dependency ordering** — tasks in a batch run in the order created, relying entirely on the existing per-workspace FIFO queue (`dequeueNext()`); there is no explicit "task B waits on task A" relationship. For a linear phase breakdown (the primary use case) creation order is sufficient; a true dependency graph is deferred.
- Global/Inbox task creation (`workspaceId: null`) — this tool is workspace-chat only.
- Any new UI — the existing Task Drawer/queue view already renders every field this tool populates.

---

## Design

### Data model

No schema changes. Every field this feature needs already exists on `Task`/`NewTaskInput` (`workspace-store.ts`): `plan: PlanStep[] | null`, `trackerType`/`trackerId`, `assignedTo`, `origin`, `triggerType`. This is purely a new write path onto the existing model.

### New store method

`WorkspaceStore.createTasks(inputs: NewTaskInput[]): Task[]` — new method alongside the existing single-row `createTask()`. Reuses `createTask()`'s per-row insert logic (including the existing R14 auto-enqueue behavior for `assignedTo: 'agent'` + `status: 'ready'` rows), wrapped in one SQLite transaction so the batch is all-or-nothing: either every row (and its matching `task_queue` entry) is created, or none is.

*Implementation-planning note:* this assumes the underlying sqlite wrapper (`SqliteDatabase` from `@tkottke90/llm-common-types/db`) exposes a synchronous transaction API the way `better-sqlite3`'s `db.transaction()` does. This should be confirmed against the actual library during implementation planning, before the atomic-batch guarantee is assumed to hold.

### New tool: `create_tasks`

Added to `STATIC_CHAT_TOOLS` in `chat-agent.ts` — built-in (always available), bound only where workspace context exists (`buildWorkspaceChatAgent`, `buildTaskAgent`), **not** in the plain `buildChatAgent` tool list. No skill-gating: task creation is treated as core to how the agent works now, not an opt-in power-user action, and creation itself has already been decided to need no separate approval gate (see below).

**Schema:**

```ts
{
  trackerUrl?: string, // e.g. a GitHub issue/PR URL — applies to every task in this batch
  tasks: [{
    title: string,
    description?: string,
    outcome?: string,
    plan?: string[]      // fine-grained checklist steps within this one task's own run
  }]
}
```

**Call flow:**

1. Read `workspaceId` off `config.configurable.workspaceId`, the same pattern `spawn_sub_agent` already uses. Missing → return an error string, no DB write. (Defense in depth: the tool isn't bound outside workspace context, but this guards against a future wiring mistake.)
2. Validate the whole batch before any write: `tasks` non-empty, at most 20 entries, every entry has a non-empty `title`. Any failure → reject the whole call with a message naming the problem entry; nothing is created.
3. If `trackerUrl` is given, resolve it once via the existing `getTrackerRegistry()` (the same adapter the Task Drawer UI already calls) → `{trackerType, trackerId}`, applied to every task in the batch. Resolution failure (bad URL, wrong host, adapter error) fails the whole call — no tasks are created unlinked when a link was explicitly requested.
4. Map each entry to `NewTaskInput`: `workspaceId`, `title`, `description`, `outcome`, `plan: plan?.map(step => ({ step, done: false })) ?? null`, `assignedTo: 'agent'`, `status: 'ready'`, `origin: 'user'`, `triggerType: 'chat'`, plus the resolved tracker fields.
5. `store.createTasks(inputs)` — one transaction; returns the created rows with ids.
6. `getTaskScheduler().wake()` once, after commit — not once per task.
7. Return a summary to the model: created task ids/titles, plus the linked tracker item if any.

### Execution (unchanged)

Nothing about how a task *runs* changes. Newly created tasks enqueue behind any already-running/pending work in that workspace's existing FIFO queue (`dequeueNext()`), execute one at a time via the existing `executeTask()`/`buildTaskAgent()` pipeline, and post into the workspace's persistent chat thread with `task_run_marker` banners exactly as today. The `plan` checklist, if set, is visible to that task's own run as part of its context but is not separately queued, cancelled, or resumed — it's scoped to that one task's execution, distinct from the coarser task-to-task boundaries the batch itself provides.

---

## Error Handling & Edge Cases

| Case | Behavior |
|---|---|
| `tasks` array is empty | Reject before any DB access — "at least one task is required." |
| A task entry fails validation (no `title`, or empty string) | Validate the whole batch up front. Any invalid entry fails the entire call, naming which entry and why — no partial batch. |
| Batch exceeds 20 tasks | Reject with a clear message. Guards against a model over-decomposing a plan, not a real workflow limit. |
| `trackerUrl` given but unresolvable (bad URL, wrong host, network/auth failure) | Whole call fails, no tasks created — a broken link never silently downgrades to "create the tasks anyway." |
| `workspaceId` from context no longer exists (workspace deleted mid-conversation) | Reject with a not-found error, mirroring the existing `tasks.handlers.ts` pattern. No tasks created. |
| DB failure partway through the transaction | Whole transaction rolls back — no partial batch, no orphaned ids returned to the model. |
| Workspace already has running/pending tasks | No special handling — new tasks enqueue at the back of that workspace's existing FIFO queue; they do not jump ahead of in-flight work. |
| Same GitHub issue linked across multiple batches | Allowed, no dedup — matches today's manual Task Drawer behavior (no uniqueness constraint on tracker links). |
| Model calls `create_tasks` twice in one turn | No idempotency guard — two batches get created. Reviewable/deletable via the Task Drawer like any other task; not worth engineering around. |
| Any failure above | Returned as the tool's own return value (a plain error string the model can relay), not an interrupt/HITL pause — creation was explicitly decided to need no confirmation gate. |

---

## Testing

**Unit** (`workspace-store.test.ts`, `create-tasks.tool.test.ts`):
- `createTasks()`: creates all rows + matching `task_queue` entries in one transaction; a failure partway through rolls back everything; returns created rows in input order.
- Tool: maps `plan: string[]` → `PlanStep[]` with `done: false`; stamps `assignedTo: 'agent'`, `status: 'ready'`, `origin: 'user'`, `triggerType: 'chat'`; rejects (no store call) on missing `workspaceId`, empty `tasks`, over-cap batch, or any invalid title; calls `getTaskScheduler().wake()` exactly once per batch.

**External-orchestration** (mocked tracker adapter, no real GitHub calls): `trackerUrl` resolves and stamps `trackerType`/`trackerId` on every task in the batch; adapter throws → whole call fails, store never called (spy-verified).

**Orchestration** (`chat-agent.test.ts`): `create_tasks` is present in the workspace-chat/task-agent tool list and absent from the plain chat-agent's tool list.

**Evaluations** (new `suites/task-creation.yaml`, per this repo's EDD rule for new LLM-facing tools):
- `tool-call`: given an approved design discussion and a "let's get started," the model calls `create_tasks` with a sensible, ordered batch.
- `tool-call` (negative): mid-brainstorm, before the user has approved anything, the model does not call `create_tasks` prematurely.
- `tool-sequence`: a GitHub issue URL present in the conversation is passed as `trackerUrl` rather than re-typed into `description` from memory.

**E2E:** no new UI is introduced (existing Task Drawer/queue view already renders every field this tool populates), so this likely doesn't trip the "UI behaviour needs E2E" rule. One `@functional`-tagged test is planned regardless — mocking the chat SSE stream to emit a `create_tasks` tool call and asserting the tasks land in the queue correctly — since this is a background/system-integration flow, not a UI change. Whether this is sufficient should be revisited during implementation planning.
