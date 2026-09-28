# Kanban Board v2 — Implementation Plan

## Context

Implements the approved spec `docs/superpowers/specs/2026-09-28-kanban-board-v2-design.md` (issue #83, expanded): five lanes grouped by who acts next, a server-owned `board` projection plus `POST /api/v1/tasks/:id/move`, desktop drag-and-drop, and a mobile grouped list. One PR on `claude/dreamy-fermi-umk4u1`. Work is ordered server → UI → E2E so every commit leaves `npm run lint`, `npx prettier --check .`, `npm test` green (AGENTS.md pre-commit rule).

## Spec adjustments found during exploration (update the spec in the same PR)

1. **No supertest in `api/`.** Route tests use `startTestServer(router, basePath)` from `api/src/tests/utilities/http-test-server.ts` + `fetch` (pattern: `api/src/routes/v1/workspace-chat.route.test.ts:39-56`, booting `bootWorkspaceStore`, `bootThreadStore`, `bootTaskScheduler`, `bootCronRegistry`).
2. **Sheets are `@tkottke90/preact-dialog`, not `ui/src/components/ui/sheet.tsx`.** Use its `Drawer` (desktop side sheet, already used by `task-drawer.tsx`) and `BottomSheet` (mobile; used in `provider-model-picker.tsx:255`). Neither supports swipe — tap-outside only, as the spec allows.
3. **Run now on `cron_once` (D10).** `settleCronRun` (`api/src/services/cron-settlement.ts:38-72`) returns a manual pre-fire run to `scheduled`. To "consume" the schedule, the move plan converts the task to `triggerType: 'manual'` (clearing `triggerConfig`) before enqueueing, so settlement takes the run's real outcome.
4. **Dequeue must delete the row.** `detachQueueEntry` (`workspace-store.ts:1809`) marks the row `cancelled`, which `listTaskRuns` would show as a phantom run. New `dequeueTask` DELETEs the never-started `pending` row.
5. **Drop on Done must release dependents.** `patchTask` doesn't call `releaseEligibleDependents` (only `completeQueueEntry` does, `workspace-store.ts:1668`). The move executor calls it after any manual `done`/`cancelled`.
6. **Mobile viewport in E2E.** `e2e/playwright.config.ts` has no mobile project; the mobile spec uses `test.use({ viewport: { width: 390, height: 844 } })`.

## Phase 1 — API: store & thread-store primitives

`api/src/services/workspace-store.ts`

- `dequeueTask(taskId): boolean` — in a transaction, DELETE the task's `task_queue` row where `status = 'pending'`, patch task to `pending`; return false (no-op) if the active row is `running`/`paused` or absent.
- `reorderQueue(taskId, index): boolean` — collect this task's workspace's `pending` rows (join `tasks` on `COALESCE(workspace_id,'inbox')`) ordered by position; move the task to `index`; reassign the **same set of position values** (sorted) to the reordered list so other workspaces' interleaving is untouched. Running/paused rows never move.
- Batch readers for the board context (one query each, `WHERE task_id IN (…)`):
  - `listDependenciesForTasks(ids): Map<taskId, (TaskDependency & { target: TaskRef & { status } })[]>`
  - `failedRunStreaks(ids): Map<taskId, { attempts, lastSummary }>` — consecutive trailing `failed` rows per task (window function over `task_queue` ordered by `enqueued_at DESC`).
  - Active queue rows already come from `listQueue()` (one query).
- Make `releaseEligibleDependents` callable from the handler layer (export/public if not already).

`api/src/services/thread-store.ts`

- `listPendingHitlPrompts(threadIds): Map<threadId, ThreadMessageRecord>` — single query on `kind = 'hitl_prompt' AND status = 'pending' AND thread_id IN (…)`, newest per thread. Replaces the 200-row `getThreadMessages` filter pattern for this use.

Tests (`workspace-store.test.ts`, `thread-store.test.ts`, `[unit]`): dequeue deletes pending row & leaves no run in `listTaskRuns`; dequeue refuses running/paused; reorder within workspace A leaves B's relative order and positions intact; running row unmoved; streak counts only trailing failures; pending-prompt lookup ignores answered prompts and other kinds.

## Phase 2 — API: `board-rules.ts` (pure)

New `api/src/services/board-rules.ts` with the types from spec §1.1 (`Lane`, `Move`, `TaskRef`, `BoardReason`, `Board`, `BoardContext`, `MovePlan`, `Rejection`) and:

- `boardFor(task, ctx): Board` — spec §1.2 table, first match wins; `moves` = every lane whose `planMove` isn't a `Rejection` (single source of truth: `moves` is derived from `planMove`, so they can't disagree).
- `planMove(task, ctx, to, opts): MovePlan | Rejection` — spec §1.3 table. `MovePlan` is an ordered list of typed steps: `enqueue`, `dequeue`, `pause`, `resume` (patch `ready`), `patch_status`, `disable_trigger`, `clear_trigger`, `save_cron_once {fireAt, timezone}`, `reassign_to_agent`, `answer_prompt {threadId, promptId}`, `reorder {index}`, `release_dependents`.
- `needs` per move: `start_time` (Scheduled target), `reply` (waiting → Queue), `reassign` (user-assigned → Queue), else `none`.
- `schedule_paused` = cron trigger with `schedule.inactiveReason === 'failures'`; `exhausted|expired|fired` + `pending` → Done lane. Reuse `describeTaskSchedule` output via `withSchedule` (`tasks.handlers.ts:143`) — no re-derivation.

Tests `board-rules.test.ts` `[unit]`: one `it` per move-table cell incl. every ✗ with its rejection text; one per §1.2 row; `moves` equals non-rejected `planMove` targets; `needs` per move. Fixtures build `Task` + `BoardContext` literals — no DB.

## Phase 3 — API: context builder, move handler, route

`api/src/routes/v1/tasks.handlers.ts`

- `buildBoardContexts(store, threadStore, tasks): Map<id, BoardContext>` — calls the Phase 1 batch readers once each; waiting tasks' prompt thread = their `paused` queue row's `threadId` (`pauseReason 'chat'`).
- `withBoard(store, threadStore, task, ctx)` layered on `withSchedule`. `listTasksHandler`, `getTaskHandler`, `patchTaskHandler` responses include `board`.
- `moveTaskHandler(store, threadStore, id, body)` — hand-validated body like the existing handlers (`typeof` checks; `resolveCronConfig` validates `startAt`/`timezone`). Rebuild ctx → `planMove` → 409 on `Rejection`, 400 on missing required input → execute steps by delegating to existing handlers/store methods: `enqueueTaskHandler` (302), `pauseTaskHandler` (433), `patchTaskHandler` (189; for `resume`, `patch_status`, `reassign_to_agent`, and trigger saves via `triggerType`/`triggerConfig` with the full stored config + `enabled:false` for `disable_trigger`), `answerTaskPrompt` (349), `store.dequeueTask`, `store.reorderQueue`, `store.releaseEligibleDependents`. Stop at the first failed step and return its failure. Returns `withBoard(fresh task)`.

`api/src/routes/v1/tasks.route.ts`: `POST /:id/move` → handler; on success `getTaskScheduler().wake()` and `getCronRegistry().sync(id)` (route-layer convention, `tasks.route.ts:117-120`). List/get routes pass `getThreadStore()`.

Tests:

- `tasks.handlers.test.ts` `[unit]` (real temp SQLite, existing pattern at 46-55; `waitingRun()` fixture at 1002 for reply): each step kind produces the right state; stale move → 409; missing `startAt` → 400; Scheduled → Backlog stays `pending` with `enabled:false`; Run now `cron_repeat` → after `completeQueueEntry` back to `scheduled`; Run now `cron_once` → trigger `manual`, outcome kept; Done drop releases a waiting dependent; Ready → Backlog leaves no run row; response carries `board`.
- `tasks.route.test.ts` `[orchestration]` (new, `startTestServer`): `POST /move` wakes scheduler & syncs registry (spies); `GET /tasks` includes `board` and calls each batch reader exactly once regardless of task count (sinon spies).

## Phase 4 — UI: data layer

- `ui/src/services/tasks-api.ts`: add `Lane`, `Move`, `BoardReason`, `Board` types (mirror server); `board: Board` on `Task`; `moveTask(id, body): Promise<Task>`.
- `ui/src/hooks/use-tasks.ts`: `moveTask` wrapper replacing the task in `tasks.value`, then `refreshQueue()`; `replaceTask(task)` helper for optimistic rollback.
- `ui/src/hooks/use-live-events.ts`: `task_completed` / `hitl_prompt` stop calling `patchTaskStatus` for status and instead `refreshTasks()` (keep the thread `hydrate()` call). `task_queue_update` already refetches.
- New `ui/src/hooks/use-media-query.ts` (`useMediaQuery(query)`); reimplement `useIsMobileViewport` on it. New `ui/src/utils/local-storage.ts` (`readJson`/`writeJson`, try/catch) — the pattern is duplicated in 5 places; only the new code uses it (no unrelated refactor).

Tests (Jest): live events refetch instead of patch; `useMediaQuery` responds to change (reuse `mockMatchMedia` from `use-is-mobile-viewport.test.tsx`); local-storage helpers fall back when storage throws.

## Phase 5 — UI: desktop board

`npm i -w ui @dnd-kit/core @dnd-kit/sortable` (Vite already aliases `react`→`preact/compat`, `ui/vite.config.ts:10-15`; add the same alias to Jest `moduleNameMapper` if missing).

New `ui/src/components/task-board/`:

- `board-card.tsx` — replaces `TaskCard` (`[id].tsx:171-253`); keeps `forwardRef`, `data-testid="task-card"`, `data-task-id`, adds `data-status`; reason line from `board.reason` (drops the per-card `listTaskDependencies` fetch); keeps `ScheduleCardLine` (`task-card-schedule`); `compact` prop; optional primary action slot.
- `board-lane.tsx` — `data-column={lane}`, header/count/subtitle, `useDroppable`; highlight vs not-allowed from the active card's `board.moves`.
- `task-board.tsx` — `DndContext` (Pointer sensor with 6px activation distance so click still opens the drawer, Keyboard sensor with sortable coordinates), `SortableContext` for Queue Ready cards, `DragOverlay`. Drop handler: not in `moves` → no-op; `needs` → open prompt; else optimistic move, `moveTask`, on error rollback + `showToast('error', …)` (`ui/src/lib/toast.ts:13`).
- `move-prompts.tsx` — start-time dialog reusing `CronOnceFields` (`cron-once-fields.tsx`, `data-testid="cron-once-fire-at"`); reassign confirm.
- **One controlled drawer**: replace the per-card `TaskDrawer` trigger wrapping (`[id].tsx:123-131`) with a board-level `selectedTask` signal + `Drawer open={signal}` so drag listeners and dialog triggers don't fight. Requires an optional `open?: Signal<boolean>` prop on `TaskDrawer`.

`ui/src/components/task-drawer.tsx`: status callout from `board.reason` — reply form (question, `choices` quick replies, free text → `move {to:'queue', reply}`), Retry (attempt count), Mark unblocked, Run now / Reschedule, "Move to…" from `board.moves`. Existing Pause/Cancel/Take over stay.

`ui/src/pages/workspaces/[id].tsx`: `TasksTab` renders `TaskBoard` at ≥1024px, `TaskListMobile` below (`useMediaQuery('(min-width: 1024px)')`); remove `KanbanColumn`, `COLUMN_ORDER`, `TaskCard`. Add task drawer gains "Add to queue" + optional start time → `createTask` then `moveTask`.

Tests (Jest): move `ui/test/task-card.test.tsx` → `board-card.test.tsx` (each reason variant, primary action gated on `moves`); `board-lane.test.tsx`; `task-board.test.tsx` drop handler (call `onDragEnd` directly: no-op, needs→prompt, optimistic + success replace, 409 rollback + toast); `task-drawer.test.tsx` additions for callouts.

## Phase 6 — UI: mobile list

`ui/src/components/task-board/task-list-mobile.tsx` — sections per spec §3 derived from `board.lane`; collapse state via `local-storage.ts` (one key; Finished collapsed by default); empty sections hidden; compact cards with one primary action (only when its move is allowed) → `moveTask` + success toast; tap waiting card → `reply-sheet.tsx` (`BottomSheet`), other → `TaskDrawer` full-width; `quick-add-sheet.tsx` (title, Agent/Me, Add to queue now, More details → full drawer prefilled).

Tests (Jest): grouping/order, collapse persists across remount, storage-throws fallback, empty sections hidden, reply sheet sends `move` with the chosen choice, quick add creates then moves.

## Phase 7 — E2E

Update the six specs using status `data-column` values to lane ids (`pending`→`backlog`, `ready|running`→`queue`, `done`→`done`, `scheduled`→`scheduled`), asserting exact status via `data-status`: `task-kanban`, `task-queue-widget`, `inbox-tasks`, `task-plan-field`, `002-GitHubTrackerWorkflow`, `live-task-events`. Any failure not explained by lane ids → stop and report.

New specs (TestSuite pattern, `e2e/AGENTS.md:143-174`; add new testids to its table):

- `task-board-dnd.spec.ts` `@user-workflow` — Backlog→Queue; reorder Ready within Queue (noop executor keeps the first task `running`, so later ones stay pending); drop on Scheduled → picker → saved; Scheduled→Backlog; illegal drop no-op; keyboard pick-up/move/drop; `page.route` forced 409 → snap back + toast.
- `task-board-mobile.spec.ts` `@user-workflow`, `test.use({ viewport: {width:390,height:844} })` — reply via sheet (seed `waiting_on_user` via `page.route` on `GET /api/v1/tasks` and on `/move`), Retry, Run now, collapse Finished, quick add.
- `@smoke` in `task-board-dnd.spec.ts` — five lanes with correct counts from seeded tasks.

## Phase 8 — Docs & wrap-up

- Update the spec with the six adjustments above.
- `api/AGENTS.md` / `ui/AGENTS.md`: note `board-rules.ts` as the only place lane/move rules live, and the `task-board/` component folder.
- No `TODO_LIST.md` change (#83 isn't listed). PR description: touch drag intentionally omitted (D8), new endpoints (D11).

## Verification

1. After each phase: `npm run lint && npx prettier --check . && npm test` from repo root.
2. `npm run test:e2e:ci` after Phase 7.
3. Manual: `npm run dev:api` + `npm run dev:ui`, seed a workspace with one task per status (incl. a `cron_repeat`, a dependency chain, a failed run), drag every cell of the move table on desktop, then repeat at 390px width in devtools; screenshot both via the `run` skill.
