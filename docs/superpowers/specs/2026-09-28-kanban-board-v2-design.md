# Kanban Board v2 — Design

**Date:** 2026-09-28
**Status:** Draft
**Related:** [Issue #83](https://github.com/tkottke90/amazing-hashbrown/issues/83) (drag-and-drop task status), [Cron task triggers design](./2026-09-26-cron-task-triggers-design.md), [Task dependencies design](./2026-09-22-task-dependencies-design.md)

---

## Goal

Replace the workspace Tasks tab's eight status columns with five lanes grouped by **who acts next**, make cards draggable between lanes (issue #83), and give narrow screens a purpose-built list with one-tap actions instead of a squeezed board. One spec, one PR.

---

## Problem

- The board has a column per `TaskStatus` (`ui/src/pages/workspaces/[id].tsx:63`). Eight columns don't fit on a laptop and are unusable on a phone.
- Status can only be changed by opening the task drawer.
- Status is not a status change: pause, cancel, enqueue, take-over, trigger save and HITL answers are separate endpoints with their own side effects. A drag that sends `PATCH { status }` would bypass them and corrupt state (e.g. a scheduled task patched to `pending` gets flipped back by `statusAfterTriggerSave`, or still fires).
- The facts a useful card needs — the agent's pending question, the failure summary, the attempt count, which dependency it waits on — are not on the task row. Fetching them per card is an N+1.
- There is no way to take a task out of the queue without cancelling it, and no way to reorder the queue.

---

## Decisions (and why)

| #   | Decision                                                                                                                                                                                       | Rationale                                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Five lanes: **Backlog, Scheduled, Queue, Needs attention, Done**. Exact status stays on each card as a badge.                                                                                  | Grouped by who acts next; fits a laptop; no information lost.                                                                                                                              |
| D2  | Tasks waiting on an unfinished dependency live in **Backlog** with a "Waiting on INF-12" badge.                                                                                                | They're `pending` and nobody can act — they move on their own. "Needs attention" must only hold things a person can act on, or it gets ignored.                                            |
| D3  | **User-assigned** tasks live in Backlog with a "You" chip until done. Queue holds agent work only. Dropping a user task on Queue requires a "Hand this to the agent?" confirm.                 | Queue means "the agent runs these one at a time"; the API only enqueues `assignedTo === 'agent'`.                                                                                          |
| D4  | **The server owns the board.** Each task carries a computed `board: { lane, moves, reason? }`; one `POST /tasks/:id/move` endpoint executes any move. The UI never maps a drop to an endpoint. | Legality depends on more than status (`blockedReason`, `assignedTo`, schedule state, queue entry). One rules module means rules change in one place; a future agent tool can reuse `move`. |
| D5  | Card detail is a **typed `board.reason` union**, computed in batch on the list endpoint.                                                                                                       | Avoids N+1 and the untyped-bag failure mode AGENTS.md warns against.                                                                                                                       |
| D6  | **Drop on Done never touches `plan`.**                                                                                                                                                         | Marking done by hand must not claim steps that never ran.                                                                                                                                  |
| D7  | **No Undo.** Actions show a confirmation toast; reversal is an ordinary move (dequeue, pause).                                                                                                 | A re-queued task can start immediately; Undo can't unrun it. Delayed commits lie about state or lose the action.                                                                           |
| D8  | **No touch drag.** Below 1024px the board is a grouped list with per-card actions and a "Move to…" picker.                                                                                     | Explicit one-tap actions beat touch drag. Knowingly deviates from #83's "drag works on touch" criterion — the PR description says so.                                                      |
| D9  | Scheduled schedules that stopped: `inactiveReason: 'failures'` → **Needs attention**; `exhausted` / `expired` / `fired` → **Done**.                                                            | A schedule paused by failures needs a person; a finished schedule doesn't.                                                                                                                 |
| D10 | **Run now on a `cron_once` task consumes the schedule.** Run now on `cron_repeat` runs once and returns to `scheduled` (existing `cron-settlement.ts` behavior).                               | Running a one-shot early and again at its original time is surprising.                                                                                                                     |
| D11 | Deviations from #83's developer notes: new API endpoints are required, and changes are not isolated to `[id].tsx`.                                                                             | The notes assumed `PATCH { status }` suffices; it doesn't (see Problem).                                                                                                                   |

---

## 1. Server

### 1.1 `api/src/services/board-rules.ts` (new, pure)

No I/O. Two functions:

```ts
type Lane = 'backlog' | 'scheduled' | 'queue' | 'attention' | 'done';

interface Move {
  to: Lane;
  needs: 'none' | 'start_time' | 'reply' | 'reassign';
}

interface TaskRef {
  id: string;
  title: string;
  trackerId: string | null;
}

type BoardReason =
  | { kind: 'waiting_on_user'; question: string; choices: string[] }
  | { kind: 'failed'; summary: string | null; attempts: number } // consecutive failed runs
  | { kind: 'paused' } // human-paused 'blocked'
  | { kind: 'dependency_failed'; dependency: TaskRef }
  | { kind: 'schedule_paused'; failures: number }
  | { kind: 'waiting_on_dependency'; dependencies: TaskRef[] }
  | { kind: 'assigned_to_user' };

interface Board {
  lane: Lane;
  moves: Move[];
  reason?: BoardReason;
}

function boardFor(task: Task, ctx: BoardContext): Board;
function planMove(task: Task, ctx: BoardContext, to: Lane, opts: MoveOptions): MovePlan | Rejection;
```

`BoardContext` is the pre-fetched facts for one task: its queue entry (if any), its dependencies and their statuses, `TaskSchedule`, the pending `hitl_prompt` message (if any), and the consecutive-failed-run count. `MovePlan` is `{ needs, steps }`, where each step is one typed operation (`enqueue`, `dequeue`, `detach_paused`, `pause`, `resume`, `patch_status`, `disable_trigger`, `enable_trigger`, `clear_trigger`, `save_cron_once`, `reassign_to_agent`, `answer_prompt`, `reorder`, `release_dependents`) executed in order. `Rejection` carries a human-readable reason.

Everything derivable client-side stays out of `board`: "Step n of m" comes from `plan`; schedule text comes from `schedule`.

### 1.2 Lane assignment

| Condition (first match wins)                                                   | Lane      | `reason`                |
| ------------------------------------------------------------------------------ | --------- | ----------------------- |
| `waiting_on_user`                                                              | attention | `waiting_on_user`       |
| `failed`                                                                       | attention | `failed`                |
| `blocked`, `blockedReason === 'dependency_failed'`                             | attention | `dependency_failed`     |
| `blocked` (human-paused)                                                       | attention | `paused`                |
| cron trigger, `schedule.inactiveReason === 'failures'`, not running/queued     | attention | `schedule_paused`       |
| `ready`, `running`                                                             | queue     | —                       |
| `scheduled`                                                                    | scheduled | —                       |
| `done`, `cancelled`                                                            | done      | —                       |
| cron trigger, `inactiveReason` in `exhausted` / `expired` / `fired`, `pending` | done      | —                       |
| `pending`, `assignedTo === 'user'`                                             | backlog   | `assigned_to_user`      |
| `pending`, unmet dependencies                                                  | backlog   | `waiting_on_dependency` |
| `pending`                                                                      | backlog   | —                       |

### 1.3 Move table (as implemented)

✗ = not in `moves`; the UI shows a not-allowed outline and sends nothing. "Picker" = `needs: 'start_time'`, executes `save_cron_once`. "+ release" = `release_dependents`, run after every manual `done` so waiting dependents are unblocked exactly as a finished run would unblock them. `board-rules.test.ts` pins every cell.

| From ↓ / To →                   | Backlog                                             | Scheduled                              | Queue                                                 | Needs attention | Done                                |
| ------------------------------- | --------------------------------------------------- | -------------------------------------- | ----------------------------------------------------- | --------------- | ----------------------------------- |
| Pending (agent)                 | —                                                   | picker                                 | `enqueue`                                             | ✗               | `patch_status done` + release       |
| Pending (user)                  | —                                                   | picker                                 | `reassign_to_agent`, `enqueue` (needs `reassign`)     | ✗               | `patch_status done` + release       |
| Pending (waiting on dependency) | —                                                   | ✗                                      | ✗                                                     | ✗               | `patch_status done` + release       |
| Scheduled                       | `disable_trigger`                                   | picker (reschedule; `cron_once` only)  | Run now: `enqueue`; `cron_once` first `clear_trigger` | ✗               | `disable_trigger`, `done` + release |
| Ready                           | `dequeue`                                           | `dequeue`, picker                      | `reorder`                                             | ✗               | `dequeue`, `done` + release         |
| Running                         | ✗                                                   | ✗                                      | —                                                     | `pause`         | ✗ (cancel lives in the drawer)      |
| Waiting on you                  | ✗                                                   | ✗                                      | `answer_prompt` (needs `reply`)                       | —               | ✗                                   |
| Blocked (paused)                | `detach_paused`, `patch_status pending`             | `detach_paused`, `pending`, picker     | `resume` (existing blocked → ready path)              | —               | `detach_paused`, `done` + release   |
| Blocked (dependency failed)     | `patch_status pending`                              | ✗                                      | ✗ (take over, or remove the dependency)               | —               | `patch_status done` + release       |
| Failed                          | `patch_status pending`                              | picker                                 | `enqueue` (retry)                                     | —               | `patch_status done` + release       |
| Schedule paused (failures)      | `clear_trigger` (stop scheduling it)                | `enable_trigger` (resume the schedule) | `enqueue` (one manual run)                            | —               | `patch_status done` + release       |
| Done / Cancelled                | `patch_status pending`; cron: `clear_trigger` first | picker (not for `cron_repeat`)         | `enqueue` (rerun)                                     | ✗               | —                                   |

Every `patch_status done` leaves `plan` untouched (D6). A drag never overwrites a `webhook` or `cron_repeat` trigger with a one-off time — those are rejected with a pointer to the task details.

### 1.4 `POST /api/v1/tasks/:id/move`

Body: `{ to: Lane; position?: number; startAt?: string; timezone?: string; reply?: string; assignTo?: 'agent' }`.

1. Load the task and build its `BoardContext` fresh.
2. `planMove`. On `Rejection` → **409** with the reason. On a missing required input (`startAt` for a picker move, `reply` for a reply move, `assignTo: 'agent'` for a reassign move) → **400**.
3. Execute the plan through existing handlers wherever one exists (`enqueueTaskHandler`, pause, the trigger-save path, `patchTaskHandler`, the HITL task-answer path for `reply`) so their invariants and side effects apply.
4. Wake the scheduler if the plan enqueued anything.
5. Return the updated task with its fresh `board`.

### 1.5 New store operations

- `dequeueTask(taskId)` — deletes the task's **pending** `task_queue` row and sets the task to `pending`. Throws/returns a conflict if the row is `running` or `paused`.
- `reorderQueue(taskId, position)` — `position` is the 0-based index among the task's **workspace's** pending rows. Rewrites `position` values only within that workspace's slice of the global ordering, so other workspaces' relative order is unchanged. The running row is never moved.

### 1.6 List and read endpoints

`GET /tasks`, `GET /tasks/:id`, and the `move` response each carry `board`. The list builds all contexts with one batched query per fact type (queue rows, dependency edges + statuses, pending HITL prompts via each task's latest run thread, failed-run streaks), not per task.

### 1.7 Live events

`use-live-events.ts` stops patching `status` locally on `task_queue_update` and re-fetches the affected tasks, so `lane` and `moves` are never stale client-side.

### Out of scope

An agent tool that calls `move`. (If added later, it needs a `tool-call` eval.)

---

## 2. Desktop UI (≥ 1024px)

Board code leaves `ui/src/pages/workspaces/[id].tsx` for `ui/src/pages/workspaces/task-board/` (see implementation note 8):

- `task-board.tsx` — `DndContext` + five lanes; header line "N tasks · N running · queue runs one at a time"; Add task button.
- `board-lane.tsx` — header, count, subtitle; highlighted when the dragged card's `moves` include it, not-allowed outline otherwise. `data-column={lane}`.
- `board-card.tsx` — status badge, tracker id, title, reason line (rendered from `board.reason.kind`), plan progress, "Step n of m" on running cards, due date, assignee. Reuses `card-badge.tsx`. Done-lane cards dimmed. `data-task-id`, `data-status`. `compact` variant for mobile.
- `move-prompts.tsx` — start-time sheet (reuses `cron-once-fields.tsx`) and reassign confirm.

**Drag:** `@dnd-kit/core` + `@dnd-kit/sortable` (Vite already aliases `react` → `preact/compat`). Sortable only inside Queue, for reorder of Ready cards. Pointer (mouse) and keyboard sensors; no touch sensor. Card fades while dragging; target lane gets a dashed outline.

**Drop sequence:**

1. Target not in `moves` → no-op.
2. `needs` is `start_time` / `reassign` → open the prompt; cancel aborts the drop. `reply` → open the side sheet at the reply callout.
3. Optimistic update: card moves to the target lane.
4. `POST /move`. Success → replace the task with the server copy. 409 / network error → snap back + toast (`toast-container.tsx`).

**Side sheet** (`task-drawer.tsx`, extended) — status callout driven by `board.reason`: reply with `choices` as quick replies; Retry with attempt count; Mark unblocked; Run now / Reschedule for scheduled tasks; "Move to…" rendered from `moves`. Every action goes through `move`.

**Add task** — existing sheet gains "Add to queue" and an optional start time; creates the task, then issues a `move` if either is set.

---

## 3. Mobile UI (< 1024px)

`task-list-mobile.tsx`, sections derived from `board.lane`:

| Section   | Contents                                               | Default   |
| --------- | ------------------------------------------------------ | --------- |
| Needs you | lane `attention`                                       | expanded  |
| Running   | lane `queue`, `status === 'running'`                   | expanded  |
| Up next   | lane `queue` Ready in queue order, then lane `backlog` | expanded  |
| Scheduled | lane `scheduled`, sorted by `schedule.nextFireAt`      | expanded  |
| Finished  | lane `done`                                            | collapsed |

- Tap a header to collapse/expand. State persists in `localStorage` under one key (all reads/writes in try/catch; defaults apply if storage is unavailable). Empty sections are hidden.
- Cards use `board-card.tsx` `compact`, with at most one primary action, shown only if its move is in `moves`:
  - `waiting_on_user` → **Reply** (opens reply sheet)
  - `failed` → **Retry** (move to Queue)
  - `paused` → **Mark unblocked** (move to Queue)
  - `scheduled` → **Run now** (move to Queue)
- Actions show a confirmation toast; no Undo (D7).
- **Reply sheet** (`BottomSheet`): question, `choices` as tap targets, free text, Send (a `reply` move). Dismiss by tapping outside; no swipe-to-dismiss (implementation note 7).
- **Tap a card** → waiting card opens the reply sheet; any other opens `task-drawer.tsx` full-screen with the same callout and "Move to…" picker.
- **Quick add (+)** → sheet with title, Agent/Me toggle, "Add to queue now". "More details" opens the full New task sheet with those values carried over.

---

## 4. Testing

The existing E2E specs that read `data-column` — `task-kanban`, `task-queue-widget`, `inbox-tasks`, `task-plan-field`, `002-GitHubTrackerWorkflow`, `live-task-events` — cover the board being changed and are updated to lane ids. Any of them failing for another reason is reported as a regression, not patched.

**API (Mocha + Chai)**

- `board-rules.test.ts` `[unit]` — one test per move-table cell (including every ✗ and its rejection reason); lane + `reason` for every row of §1.2.
- Store `[unit]` — `dequeueTask` refuses running/paused rows; `reorderQueue` reorders within one workspace and leaves another workspace's relative order unchanged.
- `POST /move` `[orchestration]` (supertest) — each plan kind reaches its handler; stale move → 409; missing input → 400; out-of-Scheduled disables the trigger and stays `pending`; Run now on `cron_repeat` returns to `scheduled` after settlement; Run now on `cron_once` consumes the schedule; response carries fresh `board`.
- `GET /tasks` `[orchestration]` — `board` present on every task; context queries are batched (fixed count per request, asserted via store spy).

**UI (Jest)**

- `board-card` — each `reason` variant renders; primary action only when its move is allowed.
- `board-lane` — highlight vs. not-allowed from the dragged card's `moves`.
- Drop handler — optimistic move; success replaces with server copy; 409/error rolls back and toasts; each `needs` opens the right prompt.
- Mobile list — grouping and order; collapse state survives remount; falls back when `localStorage` throws; empty sections hidden.
- Live events — `task_queue_update` re-fetches rather than patching status.

**E2E (Playwright, CI-safe — no `@llm`)**

- `@user-workflow` desktop: Backlog → Queue; reorder within Queue; drop on Scheduled → picker → saved; drag out of Scheduled; illegal-lane drop is a no-op; keyboard pick-up/move/drop; forced 409 via `page.route()` snaps back.
- `@user-workflow` mobile (390×844): reply via sheet (mocked HITL prompt); Retry; Run now; collapse Finished; quick add.
- `@smoke` — five lanes render with correct counts from seeded tasks.

**Evals:** none. No agent-facing behavior changes.

---

## PR notes

The PR description must state: touch drag is intentionally not implemented (D8, deviates from #83's acceptance criteria); new API endpoints were added and changes span API + UI (D11). #83 has no entry in `TODO_LIST.md`, so no TODO update is required.

---

## Implementation notes

Found while building, and reflected in the tables above:

1. **Run now on `cron_once` clears the trigger** (`triggerType: 'manual'`) before enqueueing. `settleCronRun` returns an early manual run of an unfired one-off to `scheduled`, so simply enqueueing would run it twice; disabling it instead would settle every outcome as `pending`, losing a failure.
2. **Dequeue deletes the never-started `pending` row** (`WorkspaceStore.dequeueTask`) rather than marking it `cancelled` like `detachQueueEntry`, which would show a phantom run in run history.
3. **A paused run is closed out** (`detach_paused`) before a paused task goes to Backlog, Scheduled or Done — otherwise its `paused` queue row would stay wedged.
4. **A paused schedule's lanes**: Scheduled re-enables it (no picker — it already has its schedule); Backlog drops the trigger, because a disabled-by-failures schedule would otherwise keep the card in Needs attention.
5. **Reopening a finished cron task** (Done → Backlog) drops its spent trigger, or its `exhausted`/`expired`/`fired` schedule would put it straight back in Done.
6. **Route tests** use `startTestServer` (`api/tests/utilities/http-test-server.ts`); `api/` has no supertest.
7. **Sheets** are `@tkottke90/preact-dialog`'s `Drawer`, `Modal` and `BottomSheet`, not `ui/src/components/ui/sheet.tsx`. No swipe-to-dismiss.
8. **Where the UI lives**: page-only pieces in `ui/src/pages/workspaces/task-board/` (board, lanes, cards, mobile list) per `ui/AGENTS.md`; pieces the shared task drawer also uses in `ui/src/components/task-board/` (move flow, prompts, callout, reply form). `MovePrompts` is mounted once at the app root, like the toast container.
9. **Keyboard dragging**: Left/Right move a picked-up card to the neighbouring lane (a custom coordinate getter — dnd-kit's sortable getter can't carry a non-sortable card across lanes); Up/Down step through Queue slots.
10. **Mobile E2E** sets a 390×844 viewport per spec (`test.use`); `playwright.config.ts` has no mobile project.
