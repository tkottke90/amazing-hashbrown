# Task Cancel/Abort — Pause, Take Over, and Cancel for Queued and Running Tasks

**Date:** 2026-08-29
**Status:** Draft
**Related:** [Issue #86](https://github.com/tkottke90/amazing-hashbrown/issues/86)

---

## Problem

The task queue (`task_queue` table, `WorkspaceStore` in `api/src/services/workspace-store.ts`) has no way to cancel or abort a task once it is `ready` (queued) or `running`. There is no route or handler that removes a pending queue entry or interrupts an in-progress agent run, and reassigning a task's `assigned_to` away from `'agent'` while it is `ready`/`running` leaves the corresponding `task_queue` row completely untouched — the task keeps running underneath a reassignment that claims to have taken it away from the agent.

This was a deliberate scope exclusion when R14 (the `ready`/`running` task lifecycle and enqueue-on-ready rule) landed — real, needed follow-up work, not a permanent gap.

The UI already anticipates this: `task-drawer.tsx`'s "Running task controls" panel renders **Pause**, **Take over**, and **Cancel** buttons whenever a task's status is `running`, and the status dropdown already lists `cancelled` as an option — none of it is wired to anything. This design finishes that scaffolding rather than starting from zero.

A related discovery made while investigating: **no mechanism anywhere in this codebase today stops a live agent run mid-flight**, not even for interactive chat. The existing client-side `stopGeneration()` (`ui/src/hooks/use-thread.ts`) only aborts the browser's own fetch — the server has no `req.on('close')`/signal handling, so the backend agent run keeps executing to completion regardless. This design introduces that capability for the first time, scoped to automated tasks.

---

## Non-goals

- True LangGraph checkpoint-resume (re-invoking a graph with no new input to continue exactly where an `interrupt()` left off). Resume in this design restarts the same `task_queue` row with a continuation-flavored kickoff message on the same thread — the agent has full prior context via thread history, but restarts its own reasoning for the remaining work rather than resuming mid-graph-step. Revisit if this proves insufficient in practice.
- Hard-killing in-flight tool processes (e.g. `SIGTERM`/`SIGKILL` on a shell-executor child process). Abort is best-effort: LLM calls stop immediately (LangChain respects `AbortSignal`), but an already-spawned tool call is allowed to finish naturally and its result is discarded.
- A forced timeout that fails a task if abort doesn't take effect within some bound. Accepted as a known limitation of "best-effort graceful" for this iteration.
- Generalizing `pause_reason` beyond `'chat' | 'user'`, or building a broader "why is this paused" taxonomy.
- Any change to how HITL (`ask_user`, shell approval) interrupts work — that's LangGraph's own `interrupt()`/`Command({ resume })` mechanism and is unaffected by this design.

---

## Data model

**Task status** — no new values needed. `TaskStatus` (`api/src/services/workspace-store.ts`) already declares `'cancelled'` and `'blocked'`, both currently unused:
- Cancel → `tasks.status = 'cancelled'` (terminal).
- Pause → `tasks.status = 'blocked'` (parked, resumable).

**Migration 26** on `task_queue`:

```sql
ALTER TABLE task_queue ADD COLUMN pause_reason TEXT;   -- 'chat' | 'user' | null
ALTER TABLE task_queue ADD COLUMN paused_at TEXT;      -- ISO timestamp, set on first pause
```

`task_queue.status`'s app-level enum (`pending | running | paused | done | failed`) gains `'cancelled'`. `WorkspaceStore.completeQueueEntry(id, outcome)`'s `outcome` param type extends from `'done' | 'failed'` to `'done' | 'failed' | 'cancelled'`.

**Why `pause_reason` is required, not optional:** `TaskScheduler`'s existing chat-idle auto-pause (`pause()`/`scheduleResume()`/`resume()` in `task-scheduler.ts`) already uses `task_queue.status = 'paused'` and unconditionally resumes *any* paused row 30 seconds after the current chat turn ends. Without tagging *why* a row is paused, a user-initiated Pause would be silently auto-resumed the next time the user has an unrelated chat conversation elsewhere in the app. `TaskScheduler.resume()` must filter its lookup to `pause_reason = 'chat'`; a `pause_reason = 'user'` row is only ever un-paused by an explicit Resume action.

**Why `paused_at` is required:** `dequeueNext()` overwrites `task_queue.status` to `'running'` (and `tasks.status` to `'running'`) the moment a row is picked up, before `executeTask()` ever runs. There is no other signal by the time `executeTask()` needs to decide whether to send the normal "begin work" kickoff message or a "you were paused, continue" one. `paused_at` being non-null on the dequeued row is that signal.

---

## Execution flow — how the executor learns why it stopped

A new module, `api/src/agents/active-task-abort.ts`, structurally identical to the existing `active-sse-writer.ts`:

```ts
export type AbortIntent = 'cancel' | 'pause' | 'take-over' | null;

interface AbortEntry {
  controller: AbortController;
  intent: AbortIntent;
}

const _controllers = new Map<string, AbortEntry>(); // keyed by task_queue entry id

export function registerTaskAbort(queueEntryId: string): AbortController { /* creates + stores */ }
export function setAbortIntent(queueEntryId: string, intent: AbortIntent): boolean { /* looks up, sets, returns whether found */ }
export function clearTaskAbort(queueEntryId: string): void { /* delete */ }
```

`task-execution.ts`'s `executeTask()`:
1. At the top, calls `registerTaskAbort(entry.id)` and passes the resulting `signal` into `agent.streamEvents(input, { ..., signal })`.
2. Its existing `catch` block — today unconditionally treats any thrown error as a hard failure (`completeQueueEntry(id, 'failed')`) — now checks whether the error is an abort and, if so, reads back the stored intent before deciding the outcome:
   - `intent === 'cancel'` → `completeQueueEntry(entry.id, 'cancelled')`; `tasks.status` mirrors to `'cancelled'`.
   - `intent === 'pause'` → new `store.parkQueueEntry(entry.id)`: sets `task_queue.status = 'paused'`, `pause_reason = 'user'`, `paused_at = now` (same row, not a new one); `tasks.status = 'blocked'`. This drops the entry out of `getRunningEntry()`, so the scheduler's `tick()` immediately considers the next queued item instead of sitting idle.
   - `intent === 'take-over'` → new `store.detachQueueEntry(entry.id)`: sets `task_queue.status = 'cancelled'` and `finished_at = now`, but **does not touch `tasks.status` or `tasks.assigned_to` at all**. Those fields were already set synchronously by the `/take-over` route handler before it triggered the abort (see API surface below) — `executeTask`'s catch only needs to retire the now-orphaned queue row without clobbering a task state the user already committed to.
   - no intent recorded (genuine crash, timeout, network error) → existing `'failed'` path, byte-for-byte unchanged.
3. `finally` calls `clearTaskAbort(entry.id)`, mirroring `clearActiveSseWriter`'s placement.
4. `buildKickoffMessage(task)` branches on whether the dequeued row's `paused_at` was already set: if so, send a continuation-flavored message ("Resume this task — continue from where you left off.") instead of the fresh-start one.

**Why `take-over` needs its own intent (not just reuse of `cancel`):** `cancel`'s branch sets `tasks.status = 'cancelled'`, which is wrong for take-over — a taken-over task isn't abandoned, it now belongs to the user (`assignedTo = 'user'`, `status = 'pending'`). Reusing the `cancel` intent would create a race where `executeTask`'s async catch could overwrite the take-over route's own status write. Keeping them distinct means the executor's job for a take-over is *only* "stop running and clean up the queue row" — the task-level fields are never its responsibility for that path.

**Resume mechanism (corrected from the initial framing during design discussion):** Since Pause keeps the *same* `task_queue` row (flips it to `paused`, exactly like the pre-existing chat-pause mechanism), Resume reuses the existing `resumePausedEntry(id)` store method — which flips that same row back to `pending` — rather than calling `enqueueTask()` to create a new one. A fresh `enqueueTask()` would leave the old paused row behind as a phantom duplicate, since `listQueue()` includes `paused` rows and `patchTaskHandler`'s R14 dedup check (`alreadyQueued`) would then see two live rows for one task.

---

## API surface

Mirroring the existing `POST /:id/enqueue` pattern in `tasks.route.ts`:

| Route | Valid when | Behavior |
|---|---|---|
| `POST /api/v1/tasks/:id/cancel` | `ready` or `running` | `ready`: dequeue the row directly (no abort needed, nothing executing yet) → `tasks.status = 'cancelled'`. `running`: `setAbortIntent(entryId, 'cancel')` then abort; transition to `'cancelled'` lands asynchronously in `executeTask`'s catch, surfaced via the existing `task_queue_update` SSE broadcast. |
| `POST /api/v1/tasks/:id/pause` | `running` only | `setAbortIntent(entryId, 'pause')` then abort. |
| `POST /api/v1/tasks/:id/take-over` | `ready` or `running` | Sets `tasks.status = 'pending'` / `assignedTo = 'user'` **first** (synchronously, in the same handler), then retires the queue row via the same queue-only `detachQueueEntry(id)` used by the executor: `running` → `setAbortIntent(entryId, 'take-over')` and abort, letting the executor's catch call `detachQueueEntry` once the stream actually stops; `ready` → the route calls `detachQueueEntry(id)` itself immediately (no live run to abort). Setting the task fields before touching the queue — not after, and not left to the executor to decide — is what guarantees no clobbering regardless of how the async abort resolves. |
| `PATCH /api/v1/tasks/:id` | any | Gains a guard: reject (400) any patch that changes `assignedTo` away from `'agent'` while current `tasks.status` is `ready` or `running`. Error message points at `take-over`. Also special-cases `status: 'blocked' → 'ready'`: instead of falling into the normal R14 auto-enqueue path (which would call `enqueueTask()` and create a duplicate row per the correction above), it calls `resumePausedEntry()` on the task's existing paused queue row. |

Every route calls `getTaskScheduler().wake()` after acting, same as the existing `/enqueue` route, so the queue re-evaluates immediately rather than waiting on an unrelated trigger.

---

## Error handling

| Case | Behavior |
|---|---|
| Cancel/Pause/Take-over race — task's status changed between the UI rendering the button and the click landing | Handler re-checks live status before acting; returns 409 with the current status so the UI can refresh instead of acting on stale state |
| `POST /:id/resume` (i.e. `PATCH { status: 'ready' }`) on a task not currently `blocked` | 409 |
| `PATCH /:id` attempting `assignedTo` away from `'agent'` while `ready`/`running` | 400, message points at `take-over` |
| Abort signal doesn't stop an in-flight tool call within a bounded time (tool ignores `signal`) | Accepted limitation of best-effort graceful abort — not handled in this design; candidate follow-up if it proves to be a real problem in practice |

---

## UI

`task-drawer.tsx`'s "Running task controls" panel condition extends from `status.value === 'running'` to also cover `'ready'` and `'blocked'`, with the button set adjusted per status:

- `ready`: **Cancel**, **Take over** (no Pause — nothing running yet to pause)
- `running`: **Pause**, **Take over**, **Cancel** (as already stubbed)
- `blocked`: **Resume** only

Each action button gets a loading state (spinner, matching the existing `handleGeneratePlan` pattern in the same file) between click and the `task_queue_update` SSE event confirming the new status, since abort is asynchronous — the task may sit at `running` for a moment after Cancel/Pause is clicked. Buttons disable during that window.

Confirmation, per existing app convention (`window.confirm()`, as used for workspace delete / project close-abandon in `[id].tsx`):
- `Cancel`, and `Take over` while `running`: `confirm(...)` — both discard in-progress work.
- `Take over` while merely `ready`, and `Pause`/`Resume`: no confirmation — nothing in-flight is lost.

New `tasks-api.ts` client functions: `cancelTask(id)`, `pauseTask(id)`, `takeOverTask(id)` (POST to the three new routes) and `resumeTask(id)` (thin wrapper over `patchTask(id, { status: 'ready' })`, now handled specially server-side per the mechanism above).

---

## Testing

Following this repo's established pattern (real `WorkspaceStore` instances against `mkdtempSync` temp dirs, no mocking):

- `workspace-store.test.ts`: `parkQueueEntry`; `detachQueueEntry` (queue-only, confirms `tasks` row is untouched); `task_queue.status` `'cancelled'` round-trips; `pause_reason`/`paused_at` columns; `resumePausedEntry` reuse for the resume path.
- `task-scheduler.test.ts`: a `pause_reason: 'user'` entry is **not** touched by the chat-idle `resume()` timer; a `pause_reason: 'chat'` entry still is — regression guard for the race this design fixes.
- `task-execution.test.ts`: inject a fake `streamEvents` that throws an abort error; assert all four branches (`cancel` intent → `'cancelled'`, `pause` intent → `'blocked'`/parked, `take-over` intent → queue row retired with `tasks.status`/`assignedTo` left untouched, no intent → `'failed'` unchanged) and the continuation-kickoff message path when `paused_at` is set on the dequeued row.
- `tasks.handlers.test.ts`: the three new routes (happy path + 409 races), and the `patchTaskHandler` reassignment guard (400) plus the `blocked → ready` resume special-case.
- UI (Jest): button visibility per status, `confirm()` gating, disabled/loading state during an in-flight action.
- E2E (Playwright): extend `workspace-project.spec.ts` (or a new spec) — start a task running, Pause it, verify `blocked`, Resume, verify `running` again; separately, Cancel a running task and verify `cancelled`. LLM-dependent portions mocked per `e2e/AGENTS.md`'s existing convention.
