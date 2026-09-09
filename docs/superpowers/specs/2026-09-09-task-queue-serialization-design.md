# Task Queue Serialization — Replacing the Global Run-Guard — Design

**Date:** 2026-09-09
**Status:** Draft
**Related:** [2026-09-09-provider-concurrency-queue-design.md](./2026-09-09-provider-concurrency-queue-design.md), [2026-09-09-sub-agent-tooling-design.md](./2026-09-09-sub-agent-tooling-design.md)

---

## Goal

Let multiple tasks run concurrently — bounded by provider capacity (see the provider-queue design), not by a single global "one task at a time" rule — while still preventing two agent loops from mutating the same workspace's files concurrently.

---

## Problem

`TaskScheduler` currently enforces exactly one `task_queue` entry `running` in the whole application (`getRunningEntry()` guard, `task-scheduler.ts:129`; `dequeueNext()`, `workspace-store.ts:1027`, is a single global `WHERE status='pending' ORDER BY position LIMIT 1` query with no scoping). On top of that, every interactive chat turn calls `pause()`, which demotes any currently-running task back to `pending`/`paused` and blocks the scheduler until 30s after the chat goes idle (`CHAT_IDLE_RESUME_MS`, `task-scheduler.ts:7`) — call sites in `stream-handler.ts:759/936/1100` and `workspace-chat-stream-handler.ts:97/288/478`.

This conflates two unrelated concerns:
1. **Provider capacity** — solved properly by the provider-queue design; this global pause was a blunt workaround for its absence.
2. **Workspace mutation safety** — a task's tool calls (file writes, git operations) are not safe to run concurrently against the same workspace. This is real and must be preserved.

Once (1) is solved at the provider layer, the global pause-on-chat mechanism has no remaining purpose and should be deleted, not bypassed.

---

## Scope

**In scope:**

- Replacing the single global "one running task" invariant with two independent, narrower invariants: one in-progress task for the Inbox (tasks with `workspaceId = null`), and one in-progress task per workspace.
- Deleting `TaskScheduler.pause()`/`scheduleResume()`/`resume()` and every call site.
- Extending `dequeueNext()` to skip pending entries whose scope already has a running entry, rather than strictly following global FIFO position.

**Out of scope:**

- File/git-level isolation (worktrees) for genuinely-concurrent same-workspace work — explicitly deferred; the per-workspace serialization below is the only protection until then.
- Sub-agent runs' exemption from the "one in-progress" rule — specified in the sub-agent design, referenced here only where it changes `dequeueNext()`'s eligibility check.
- The per-thread checkpoint mutex (`active-sse-writer.ts`) — unrelated correctness mechanism (prevents a task and a live chat turn writing the same LangGraph checkpoint concurrently), stays exactly as-is. It is not a capacity or workspace-mutation concern, and this design does not touch it.

---

## Design

### 1. Scope key

Every `task_queue` entry's scope is derived from its task's `workspaceId`: `workspaceId ?? 'inbox'`. Two entries share a scope iff they have the same key. Tasks with `origin: 'agent'` (sub-agent runs — see sub-agent design) are excluded from scope accounting entirely, regardless of their `workspaceId`.

### 2. `getRunningEntry()` → `getRunningEntry(scope: string)`

```ts
getRunningEntry(scope: string): (TaskQueueEntry & { task: Task }) | null {
  // WHERE task_queue.status = 'running'
  //   AND tasks.origin != 'agent'
  //   AND COALESCE(tasks.workspace_id, 'inbox') = ?
}
```

Requires a join from `task_queue` to `tasks` that the current query doesn't do (`task_queue` alone doesn't carry `workspace_id`).

### 3. `dequeueNext()` becomes scope-aware

Current behavior picks the single oldest `pending` entry, full stop. New behavior: scan `pending` entries in position order, dispatch the **first one whose scope has no running entry** (or whose task is `origin: 'agent'`, always eligible) — not necessarily the globally-oldest entry. A stalled Inbox (its one slot occupied by a long-running task) no longer blocks a workspace's task list from making progress, and vice versa.

```ts
dequeueNext(): (TaskQueueEntry & { task: Task }) | null {
  const pending = /* SELECT task_queue.*, tasks.workspace_id, tasks.origin
                      FROM task_queue JOIN tasks ...
                      WHERE task_queue.status = 'pending'
                      ORDER BY position ASC */;
  const runningScopes = /* SELECT DISTINCT COALESCE(workspace_id,'inbox')
                            FROM task_queue JOIN tasks
                            WHERE task_queue.status = 'running' AND tasks.origin != 'agent' */;
  const next = pending.find(row =>
    row.origin === 'agent' || !runningScopes.has(row.workspaceId ?? 'inbox')
  );
  if (!next) return null;
  // ...mark running, same as today
}
```

`TaskScheduler.tick()` no longer calls a single global `getRunningEntry()` guard before dequeuing — `dequeueNext()`'s eligibility scan replaces that check. `tick()` can now dispatch more than one task concurrently across scopes; each dispatched task still runs through the existing `runTask()` fire-and-forget path (`task-scheduler.ts:149`) unchanged — multiple concurrent `runTask()` calls in flight is exactly the point.

### 4. Deleting the chat-pause mechanism

Remove entirely: `TaskScheduler.pause()`, `scheduleResume()`, `resume()`, the `resumeTimer`/`paused` fields, `CHAT_IDLE_RESUME_MS`. Remove every call site:

- `stream-handler.ts:759,919,936,1078,1100,1236`
- `workspace-chat-stream-handler.ts:97,119,273,288,304,465,478,494,649`

The `queue_status` SSE event (driven by `isPaused()`) goes with it — there is no longer a global paused/not-paused state to report. `isPaused()` itself is removed; nothing else in the codebase should depend on it after this change (confirm via a repo-wide reference check during implementation, not assumed here).

Chat turns no longer touch the scheduler at all. The only thing that still guards a task and a live chat turn from colliding is the per-thread mutex in `active-sse-writer.ts` (§ Scope, above) — unchanged, and now the *sole* mechanism protecting that specific correctness case, rather than one of two overlapping mechanisms.

### 5. Crash recovery — unaffected, still correct

`WorkspaceStore.recoverRunningQueueEntries()` (`workspace-store.ts:486`) already resets any `running` `task_queue` row to `pending` on boot (or fails it after `MAX_QUEUE_RECOVERY_ATTEMPTS`). It has no global-uniqueness assumption baked in — it operates per-row — so it needs no changes for this design. The only adjustment (covered in the sub-agent design, not here) is its escalate-to-`waiting_on_user` branch, which is wrong for `origin: 'agent'` rows.

---

## Error Handling & Edge Cases

- **A workspace is deleted/archived while its task is `running`:** unchanged behavior from today — explicitly out of scope per the existing automated-task-execution design (`#78`'s problem). Not made worse by this change.
- **Race between two `dequeueNext()` calls for the same scope:** `better-sqlite3` is synchronous and single-threaded per process, so `tick()`'s dequeue-then-mark-running is not actually racy within one process — same guarantee the current global version already relies on.

---

## Testing

- `workspace-store.test.ts`: `dequeueNext()` skips a scope with a running entry and dispatches the next eligible one instead; `getRunningEntry(scope)` returns null for an unrelated scope even while another scope has a running entry.
- `task-scheduler.test.ts`: remove all `pause()`/`scheduleResume()` test blocks; add a test asserting two tasks in different scopes both reach `running` concurrently from one `wake()`.
- Delete `pause()`/`scheduleResume()` coverage in `workspace-chat-stream-handler.test.ts` (comment at line 62 references it) and any `queue_status` event assertions.
