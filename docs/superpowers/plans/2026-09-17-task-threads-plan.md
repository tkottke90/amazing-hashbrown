# Task Threads — Implementation Plan

**Date:** 2026-09-17
**Spec:** [`docs/superpowers/specs/2026-09-17-task-threads-design.md`](../specs/2026-09-17-task-threads-design.md)
**Branch:** `task-threads-design`

Each step is a self-contained unit: implementation + its own tests. Run `npm run lint`, `npx prettier --check .`, and `npm test` in the touched workspace (`api` for Steps 1–5, `ui` for Steps 6–9) after each step before moving on.

Verified against current code (2026-09-17):

- Thread resolution in `api/src/agents/task-execution.ts` (~lines 104–133): workspace-scoped tasks reuse `workspace.threadId`; global tasks mint `task.threadId ?? randomUUID()`.
- `tasks` table already has `thread_id` and `parent_thread_id` columns (migrations 24/25 in `api/src/services/workspace-store.ts`). `parent_thread_id` serves as the origin-thread field — **no schema migration needed**.
- `deleteTask` in `workspace-store.ts` (~1091) deletes only the `tasks` row (no cascade). `ThreadStore.deleteThread` (thread-store.ts ~305) deletes messages + row in a transaction; handler composes LangGraph checkpointer deletion.
- `deleteThreadHandler` in `api/src/routes/v1/threads.handlers.ts` (~134) has no type guard.
- `listThreadsHandler` hard-filters `type: 'chat'`.
- `ThreadSummary` union (`ui/src/hooks/use-thread.ts` ~84): `'chat' | 'wiki' | 'workspace-chat'`.
- Sidebar delete button in `ui/src/components/thread-sidebar.tsx` (~125).

---

## Step 1 — Every task gets its own thread

**Files:** `api/src/agents/task-execution.ts`

Replace the workspace branch of thread resolution so workspace-scoped tasks take the same path as global tasks:

```typescript
// Both scopes: each task gets its own dedicated 'task' thread, minted
// lazily on first run. task.workspaceId remains a scope attribute only.
threadId = task.threadId ?? randomUUID();
if (!task.threadId) {
  store.patchTask(task.id, { threadId });
  threadStore.upsertThreadOnFirstMessage(threadId, task.title, 'task');
}
if (task.workspaceId) {
  // workspace lookup / context building stays, but no thread reuse:
  const workspace = store.getWorkspace(task.workspaceId);
  if (!workspace) throw new Error(...); // unchanged
  workspaceScope = { workspace, workspaceContext, allowedWikiId }; // unchanged
}
```

Keep the existing `catch` (thread-resolution failure → `completeQueueEntry(entry.id, 'failed')`) and abort registration. Do not touch workspace thread minting itself (`workspace.threadId` is still created lazily for the workspace chat surface — just not by task execution).

Update the comment at `api/src/services/workspace-store.ts:117` ("Workspace-scoped tasks reuse workspace.threadId instead") to reflect the new behavior.

**Tests** (extend `api/src/agents/task-execution.test.ts`):

- Workspace-scoped task run mints a `type: 'task'` thread and patches `task.threadId`; the workspace's `threadId` is untouched.
- Second run of the same task reuses the existing `threadId` (no `upsertThreadOnFirstMessage` re-invocation).
- Global-task behavior unchanged (existing tests keep passing).

## Step 2 — Origin-thread resolution for pointer messages

**Files:** `api/src/agents/task-execution.ts`, `api/src/services/workspace-store.ts`

Originating conversation for a pointer message:

- Workspace-scoped task → the workspace's chat thread (`workspace.threadId`). If the workspace has no thread yet, skip the pointer (nothing to attach to).
- Global task → `task.parentThreadId` (already captured at task creation). If null or the thread no longer exists (`threadStore.getThreadMeta` returns null), skip and log.

Add a small pure helper `resolveOriginThreadId(store, threadStore, task): string | null` (exported for tests) implementing the above. Call it at the terminal/blocking outcome points (completed / failed / paused / waiting_on_user) — Step 3 wires the message write itself.

**Tests:**

- Workspace task with `workspace.threadId` → returns it; workspace without a thread → null.
- Global task with existing `parentThreadId` → returns it; null parent, or deleted thread → null.

## Step 3 — Completion pointer messages

**Files:** `api/src/agents/thread-message-writer.ts` (or a new `api/src/agents/task-completion-notify.ts` following the `recordTaskRunMarker` pattern), `api/src/agents/task-execution.ts`

Add `recordTaskCompletionPointer(threadStore, originThreadId, task, outcome)` writing a short assistant-role marker message to the origin thread:

- Text variants: `completed` → "Task 'X' finished ✓ — View thread"; `failed` → "Task 'X' failed ✗ — View thread"; `paused` → "Task 'X' paused ⏸ — View thread"; `waiting_on_user` → "Task 'X' is waiting for your input ⏸ — View thread". Rendered as a link to `/threads/{task.threadId}` (link formatting matches how `task-run-marker-message.tsx` builds internal links).
- Wrap in try/catch: a pointer write failure logs and never fails task completion (spec error-handling rule).
- Wire into the outcome points from Step 2 in `task-execution.ts`.

**Tests:**

- Each outcome writes the expected variant to the origin thread.
- Origin thread resolution returns null → no write, no throw, logged.
- Throwing `threadStore` method → task still completes.

## Step 4 — Task deletion hard-cascades to its thread

**Files:** `api/src/services/workspace-store.ts`, `api/src/routes/v1/tasks.handlers.ts`

- Extend `deleteTask(id)` to also delete the task's thread: read `thread_id` first, delete the thread, then the task row. Guard: only cascade when `thread_id` is set; if thread deletion fails, abort with the task intact and surface the error (delete-thread-first avoids a half-deleted state). Compose with the LangGraph checkpointer at the handler layer, same as `deleteThreadHandler`.
- If the task is running when deleted: the delete handler first requests cancel/pause via the existing active-task-abort path and waits for graceful stop (poll queue status, bounded timeout), then cascades. Follow whatever await/timeout pattern `tasks.handlers.ts` already uses for cancellation.

**Tests** (workspace-store + handler tests):

- Deleting an idle task with a thread removes both the task row and the thread's rows (and messages).
- Deleting a task with `thread_id = null` works unchanged.
- Thread-deletion failure → task row survives, error surfaced.
- Deleting a running task: abort requested, then cascade completes.

## Step 5 — Threads API: list-all endpoint + task-thread deletion guard

**Files:** `api/src/routes/v1/threads.handlers.ts`, `api/src/routes/v1/threads.route.ts`, `api/src/services/thread-store.ts`

- New handler `listAllThreadsHandler(store, opts)`: accepts `type` filter (optional, one of `chat | wiki | workspace-chat | task`), pagination (offset/limit, matching existing route param conventions), newest-first by `updated_at`. Backs the Threads page.
- `deleteThreadHandler`: if `store.getThreadMeta(id)?.type === 'task'`, return 409 ("Task threads are managed by their task and cannot be deleted directly"). Also check `getTaskByThreadId` — if a task still references the thread, rejection applies regardless of stored type.
- `getThreadHandler` already serves any thread by id — confirm it doesn't filter on type; if the route layer gates on type, widen it.

**Tests:**

- `listAllThreadsHandler` returns all types, respects `type` filter + pagination + ordering.
- DELETE on a task thread → 409; DELETE on a chat thread → unchanged behavior.
- GET of a `type: 'task'` thread returns messages.

## Step 6 — Frontend types & tasks API exposure

**Files:** `ui/src/hooks/use-thread.ts`, `ui/src/services/tasks-api.ts`, `ui/src/components/task-drawer.tsx`

- `ThreadSummary` union gains `'task'`; thread-type display helpers (labels/icons) handle it.
- `tasks-api.ts` task type gains read-only `threadId`; task drawer renders a "View thread" link (`/threads/{threadId}`) when present.

**Tests:** type-level + a small render test for the drawer link.

## Step 7 — Threads nav page

**Files:** `ui/src/components/threads-page.tsx` (new), sidebar component, routing file (follow how `workspaces/[id].tsx` is registered)

- New "Threads" entry at the bottom of the sidebar → paginated list of all threads, all types, filterable by type (segmented control / dropdown), newest first. Rows show type badge, title, updated time, and click through to the thread view. Delete affordance hidden for `type: 'task'` rows.
- Reuse existing thread-summary rendering where possible; wire to the Step 5 endpoint.

**Tests:** page renders mixed-type list; filter narrows; pagination controls work; no delete button on task rows.

## Step 8 — Read-only task thread view + live tail

**Files:** shared thread view component (`ui/src/components/`), SSE hookup via existing `use-thread.ts` attach path

- When `thread.type === 'task'`: hide the composer/reply UI entirely.
- Mid-run (task not in a terminal state — via `getAfterAgentStatusHandler` or the task status the client already has): attach to the SSE writer forwarding shim for live tail. If attachment is impractical, fall back to load-once + manual refresh button (spec-sanctioned fallback; note which was chosen in the PR description).

**Tests:** task thread renders without composer; live events append while running; refresh works in fallback mode.

## Step 9 — Workspace deletion does not cascade

**Files:** workspace DELETE handler (`api/src/routes/v1/`), `api/src/services/workspace-store.ts`

- On workspace deletion, null out `workspace_id` on its tasks instead of deleting them (single `UPDATE tasks SET workspace_id = NULL WHERE workspace_id = ?`). Tasks, their threads, and their `type: 'task'` threads all survive. Verify current behavior first — if deletion already leaves tasks untouched, this step is just the explicit null-out + test coverage.

**Tests:**

- Delete workspace with 2 tasks (one with thread) → workspace gone; both tasks remain with `workspaceId = null`; task thread intact.

## Step 10 — End-to-end integration test

**Files:** `api/src/agents/task-execution.test.ts` (or a new integration test file)

One flow exercising the full loop: workspace-scoped task runs → writes messages to its own `type: 'task'` thread (not the workspace chat thread) → completes → pointer message appears in the workspace chat thread with correct variant → task deleted → thread hard-deleted → workspace deleted → task/thread survive with `workspaceId = null`.
