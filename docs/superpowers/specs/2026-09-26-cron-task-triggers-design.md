# Cron Task Triggers — Design

**Date:** 2026-09-26
**Status:** Draft
**Related:** [Issue #72](https://github.com/tkottke90/amazing-hashbrown/issues/72), [Issue #68](https://github.com/tkottke90/amazing-hashbrown/issues/68) (scheduler architecture), [Webhook trigger design](./2026-08-25-webhook-task-trigger-design.md)

---

## Goal

Let a task run on a schedule — once at a specific datetime (`cron_once`) or repeatedly on a cron expression (`cron_repeat`) — without anyone having to kick it off, and make repeated runs of the same task behave well: each run starts clean, knows what the previous run concluded, and can read the previous run's full transcript when it needs to.

---

## Problem

The data model is half-ready and the runtime isn't:

- `trigger_type` / `trigger_config` columns and the `'cron_once' | 'cron_repeat'` `TriggerType` members already exist (`workspace-store.ts:93`), but nothing reads them. There is no timer, no boot-time registration, and the task drawer only offers Manual / Webhook.
- **A task's runs share all state.** Workspace tasks run inside the workspace chat thread; Inbox tasks reuse one `task.threadId` forever; `plan`, `outcome`, and `resumeAnswer` carry over. Run #30 of a nightly task would start with 29 runs of history in context and a fully-checked plan that `complete_task`'s unchecked-steps guard no longer protects.
- **`complete_task`'s `summary` is never persisted** (only forwarded for sub-agent notifications), so there is nothing to tell the next run about the last one.
- **After a run, a task sits at `done`/`failed` forever** (`completeQueueEntry()`), which is wrong for a recurring task on the Kanban board, and wrongly satisfies dependency edges after the first run.
- **Inbox task HITL is broken today.** Inbox tasks run in `'task'`-type threads the UI cannot open (`use-thread.ts` only knows `chat | wiki | workspace-chat`), and `chat.route.ts`'s `/hitl` has no task-aware branch — an answer there would resume the thread as an interactive chat turn, bypassing the scheduler. An Inbox task that asks a question is stuck at "Waiting on user."
- No timezone handling exists anywhere; the `node:24` image runs in UTC.

---

## Decisions (and why)

| #   | Decision                                                                                                                                                                                          | Rationale                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Wall-clock firing, **skip if the task isn't idle**. Replaces the issue's "self-schedule at completion" R6 design.                                                                                 | R6 as written re-enqueues "immediately" (zero gap, not the claimed 15 min) and has nothing to re-arm the chain after a restart. Skip-if-busy gives the same no-overlap guarantee with far less machinery.                                       |
| D2  | **Fresh thread per run, for every task** (not just cron). Kickoff message carries the previous run's summary + exact `read_task_run` call.                                                        | Bounded context per run; each run is independently reviewable; continuity via summary rather than accumulated history.                                                                                                                          |
| D3  | `read_task_run` tool, **bound only on runs that have a prior finished run**, never mentioned in the system prompt; the kickoff message contains the exact call.                                   | A callable tool must be bound, but it need not cost context on chat turns, one-shot tasks, or first runs.                                                                                                                                       |
| D4  | Task HITL prompt cards are **mirrored into the workspace chat**; answering either copy resolves both.                                                                                             | Keeps answering-from-chat after D2 moves the transcript out of the workspace thread.                                                                                                                                                            |
| D5  | Run threads open in the normal `/chat/:id` route as a **read-only transcript**; only HITL cards are interactive. Server rejects writes.                                                           | Removes the race with live task execution on the shared checkpoint; a run is a record, not a conversation.                                                                                                                                      |
| D6  | On boot, **one catch-up run** per task that missed ≥1 fire time while down; past-due `cron_once` fires late.                                                                                      | "Nightly summary" still happens after the laptop was off; one run, not a backlog.                                                                                                                                                               |
| D7  | New **`scheduled`** `TaskStatus`; recurring tasks return to it after each run. The cron gate is `status === 'scheduled'`.                                                                         | Honest Kanban placement, correct dependency semantics, and a single, meaningful idle state to gate on.                                                                                                                                          |
| D8  | Auto-pause after `maxConsecutiveFailures` (per task, default 3, `null` = never). Only `schedule`/`catch_up` runs count; a success resets; manual runs never touch the counter or `maxIterations`. | Stops a broken job from burning model calls indefinitely without making manual troubleshooting runs costly.                                                                                                                                     |
| D9  | **Per-task IANA timezone**, prefilled from the browser.                                                                                                                                           | "Midnight" means the user's midnight, across DST, independent of server location.                                                                                                                                                               |
| D10 | **`cron-parser` v5 + a small in-house timer**; no `node-schedule` / `node-cron`. `cronstrue` + `cron-parser` run server-side only.                                                                | `node-schedule@2.1.1` pins `cron-parser@^4`; we need `cron-parser` ourselves for next-run display and catch-up, and two parsers could disagree (especially around DST). One `nextFireAt()` function drives the timer, the drawer, and catch-up. |

---

## Non-goals

- **Multi-process / horizontal scaling.** Single process only — the scaling note in #72 (BullMQ + Redis ZSET as the migration path) still applies.
- **Per-task "catch up missed runs" toggle.** Always catch up (D6) until someone needs otherwise.
- **Notifications** (toast / browser) when a scheduled run starts. A HITL-waiting notification would be useful but is a general HITL feature, not cron-specific.
- **Steering a running task** by sending messages into its run thread.
- **Follow-up chat in a run thread** after it finishes (D5).
- **`search_conversation` over previous runs.** `read_task_run` covers sequential reading; a search variant can follow if runs get long.

---

## Design

### 1. Data model

#### Run records — extend `task_queue`

A `task_queue` row is already one run: created on enqueue, kept alive across pauses/HITL (`parkQueueEntryForHitl`, `resumePausedEntry`), closed with an outcome. The next migration adds:

| Column           | Type                             | Purpose                                                                              |
| ---------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| `thread_id`      | `TEXT`                           | The run's own `'task'`-type thread. Set when the run first starts; reused on resume. |
| `summary`        | `TEXT`                           | `complete_task`'s summary, or a system summary for runs that never called it.        |
| `trigger_source` | `TEXT NOT NULL DEFAULT 'manual'` | `manual \| webhook \| schedule \| catch_up \| chat \| agent`.                        |
| `scheduled_for`  | `TEXT`                           | The fire time this run represents (the missed time for `catch_up`); null otherwise.  |

The migration **backfills** `thread_id` for rows that are `paused` or `running` at migration time, using `COALESCE(workspaces.thread_id, tasks.thread_id)` — so in-flight HITL/paused runs resume in the thread their checkpoint lives in, and the runtime needs no legacy fallback. Finished historical rows stay `thread_id = NULL` and are simply excluded from kickoff history and `read_task_run`.

New store method `listTaskRuns(taskId, { limit, offset })` returns rows newest-first with a computed 1-based `runNumber` (ordered by `enqueued_at`). `tasks.thread_id` is no longer written for new runs; it is retained for legacy rows.

`enqueueTask(taskId, opts?: { triggerSource?, scheduledFor? })` gains an optional options argument; every existing caller passes its own source (`webhook` from the webhook handler, `agent` from `createSubAgentTask`, `chat` from `create_tasks`, `manual` otherwise).

#### `trigger_config` shapes

```ts
type CronOnceConfig = {
  fireAt: string; // ISO datetime
  timezone: string; // IANA, e.g. 'America/Chicago'
  enabled: boolean;
  enabledAt: string; // server-owned
  lastFiredAt: string | null; // server-owned
};

type CronRepeatConfig = {
  expression: string;
  timezone: string;
  enabled: boolean;
  enabledAt: string; // server-owned; set on create/re-enable
  maxIterations: number | null; // counts schedule + catch_up runs only
  stopAfter: string | null; // ISO datetime
  maxConsecutiveFailures: number | null; // default 3; null = never auto-pause
  consecutiveFailures: number; // server-owned
  lastFiredAt: string | null; // server-owned
  pausedReason: 'consecutive_failures' | null; // server-owned
};
```

Validated with Zod per type in `resolveTriggerConfig()` (`tasks.handlers.ts`): `expression` must parse with `cron-parser` in the given `timezone`; `timezone` must be a valid IANA zone (`Intl.supportedValuesOf('timeZone')` or a `DateTimeFormat` probe); `fireAt`/`stopAfter` must be valid dates; `maxIterations`/`maxConsecutiveFailures` positive integers or null. **Server-owned fields** (`enabledAt`, `consecutiveFailures`, `lastFiredAt`, `pausedReason`) are always taken from the current row, never the client — the same ownership rule the webhook token uses. Invalid config → 400 with a field-level message.

#### `scheduled` status

- Added to `TaskStatus` (API + UI types, labels, Kanban `COLUMN_ORDER` between `pending` and `ready`).
- **Enter:** saving a `cron_*` task with `enabled: true`; a `cron_repeat` task after any run settles (see §2 settlement), unless the schedule is exhausted or auto-paused.
- **Leave:** fire → `ready` (normal enqueue path); schedule exhausted → `done`; `enabled: false` (user or auto-pause) → `pending`; take-over → existing take-over behaviour.
- **Re-enable:** `enabled: false → true` returns the task to `scheduled`, resets `consecutiveFailures` and `pausedReason`, and sets `enabledAt = now` — so fire times missed while the schedule was off are **not** caught up.
- **Dependencies:** `addTaskDependency` rejects an edge whose _target_ is a `cron_repeat` task ("Recurring tasks can't be dependencies"). Project-close checks treat `scheduled` as not-finished.
- **Iteration count** is computed: `COUNT(*) FROM task_queue WHERE task_id = ? AND trigger_source IN ('schedule','catch_up')`.

### 2. Cron registry

#### `api/src/services/cron-schedule.ts` — pure timing (no timers, no DB)

- `nextFireAt(config, after: Date, iterationCount: number): Date | null`
  - `cron_once`: `fireAt` if `> after`, else null.
  - `cron_repeat`: next match of `expression` in `timezone` strictly after `after`; null if that is past `stopAfter` or `iterationCount >= maxIterations`.
- `latestMissedFireAt(config, now: Date): Date | null` — the most recent fire time in `(max(lastFiredAt, enabledAt), now]`; null if none. For `cron_once`: `fireAt` if `enabledAt < fireAt <= now` and `lastFiredAt` is null.
- `describe(config): { description: string; nextFireTimes: Date[] }` — `cronstrue` text + next 3 times, used by the preview endpoint.

Every consumer — timer, preview endpoint, `schedule` field on task responses, boot catch-up — calls these.

#### `api/src/services/cron-registry.ts` — `CronRegistry`

Holds `Map<taskId, NodeJS.Timeout>`. Boot wiring mirrors `bootTaskScheduler()` / `getTaskScheduler()` (`bootCronRegistry()` / `getCronRegistry()`).

- **`sync(taskId)`** — clear any timer for the task, re-read it; if it is `cron_*`, `enabled`, `status === 'scheduled'`, and `nextFireAt()` is non-null, arm a timer. Delays over `2^31 − 1` ms are chunked (arm for the max, re-evaluate on wake). Called from the task create / patch / delete handlers, workspace delete, and run settlement.
- **`fire(taskId, scheduledFor, source: 'schedule' | 'catch_up')`**
  1. Re-read the task. If `Date.now() < scheduledFor` (early wake from drift or chunking), `sync()` and return.
  2. **Gate:** proceed only if `task.status === 'scheduled'` and `enabled`. Otherwise log at debug, `sync()`, return. (Covers queued, running, waiting_on_user, blocked, disabled.)
  3. In one transaction: set `lastFiredAt = scheduledFor`, `patchTask(status: 'ready', assignedTo: 'agent')`, `enqueueTask(taskId, { triggerSource: source, scheduledFor })`.
  4. `getTaskScheduler().wake()`.
- **`boot()`** — called in `index.ts` right after `bootTaskScheduler()`. Loads every enabled `cron_*` task at `scheduled` via a new `listScheduledTasks()` store method. For each: if `latestMissedFireAt()` is non-null, `fire(id, missed, 'catch_up')` once; then `sync(id)`.
- **`stop()`** — clears every timer; called from the shutdown path if one exists.

The registry only decides _when a run is enqueued_. Scope occupancy and dispatch remain `dequeueNext()`'s job, unchanged; an enqueued run waits behind other work in its scope like any task.

#### Run settlement — `settleCronRun(store, task, entry, outcome)`

Called from `completeQueueEntry()` for `cron_*` tasks, _after_ the queue row is closed, _instead of_ the plain `tasks.status = outcome` write:

- **`cron_once`, `trigger_source = schedule | catch_up`** — status = `outcome` (as today); never re-armed.
- **`cron_once`, manual Run now before it has fired** (`lastFiredAt` null) — status back to `scheduled` if `enabled` (else `pending`), then `sync()`; the scheduled fire still happens.
- **`cron_repeat`, `trigger_source ∈ {schedule, catch_up}`:**
  - `failed` → `consecutiveFailures += 1`; `done` → `consecutiveFailures = 0`; `cancelled` → unchanged.
  - If `maxConsecutiveFailures != null && consecutiveFailures >= maxConsecutiveFailures` → `enabled = false`, `pausedReason = 'consecutive_failures'`, status `pending`.
  - Else if `nextFireAt(config, now, iterationCount)` is null (budget used or past `stopAfter`) → status `done`.
  - Else → status `scheduled`.
- **`cron_repeat`, manual Run now:** counters untouched; status `scheduled` if `enabled`, else `pending`.
- Always finish with `getCronRegistry().sync(task.id)`.

HITL parking (`parkQueueEntryForHitl`) and user pause (`parkQueueEntry`) are not settlement — the run is still open; the task sits at `waiting_on_user`/`blocked`, which the gate already treats as busy.

### 3. Task execution

#### Per-run thread (`task-execution.ts`)

Replace the current thread resolution:

- **Queue row has `thread_id`** (resume after HITL / user pause) → reuse it. The LangGraph checkpoint and `Command({ resume })` path are unchanged.
- **Otherwise (new run)** → mint a thread, `upsertThreadOnFirstMessage(threadId, "<task title> — run #N", 'task')`, store it on the row.

Workspace tasks still get `workspaceScope` (workspace context block, wiki scope, shell cwd); they lose only the workspace chat _history_.

#### Clean slate

On a new run (not a resume), before building the agent: `patchTask(id, { plan: null, outcome: null, resumeAnswer: null })`. `description` is never touched.

#### Persisted summary

On settlement, write `task_queue.summary`:

- accepted `complete_task` → its `summary`;
- otherwise a one-line system summary: `Run failed: <error category>`, `Run cancelled by user`, `Run failed after crash recovery`.

#### Kickoff message (`buildKickoffMessage`)

Resumes keep today's "Resume this task…" text, no history. New runs:

```
Begin work on this task now: Nightly PR summary.
This is scheduled run #13 (scheduled for 2026-09-26 00:00 America/Chicago).
[catch_up only:] This is a catch-up run — the server was offline at the scheduled time.

Previous run — #12, 2026-09-25 00:00, done:
"Summarised 4 new PRs; flagged #88 as needing review."
For full details call: read_task_run({"runId":"3f1c…"})

Earlier runs: #11 9ab2… (done), #10 77de… (failed), #9 c01f… (done)
```

- The history block appears when the task has ≥1 finished run with a `thread_id`; capped at the previous run + 3 earlier ones.
- The "scheduled run" line appears only for `schedule`/`catch_up` sources; manual runs say `This is run #13 (started manually).`
- Built in `task-context.ts` (side-effect-free) so `bin/eval.ts` can import it.

#### `read_task_run` tool (`api/src/agents/tools/read-task-run.tool.ts`)

- `makeReadTaskRunTool(taskId)` — task id is closed over; the model never supplies it.
- Schema: `{ runId: string; offset?: number = 0; limit?: number = 40 (max 100) }`.
- Returns the run's messages as text lines (user / assistant / tool-call), using `extractText()` moved out of `search-conversation.tool.ts` into a shared `agents/thread-text.ts` (both tools import it). Each page ends with `(messages X–Y of Z; call again with offset=Y for more)`.
- Rejects (as a tool-result string, not a throw) a `runId` that isn't a **finished** run of this task, or the current run.
- One-line description: `"Read the transcript of a previous run of this task."`
- `buildTaskAgent` binds it only if `listTaskRuns(task.id)` contains a finished run with a `thread_id`. Not mentioned in the system prompt.

#### Workspace markers

`task_run_marker` start/end messages are written to the run thread and, for workspace tasks, mirrored into the workspace thread with added payload fields `runThreadId`, `runNumber`, `triggerSource`. The UI marker renders "Scheduled run #12 started · open run" (link to `/chat/<runThreadId>`). Inbox tasks write markers to the run thread only.

### 4. HITL routing and the read-only run view

#### Shared task-prompt handler

Extract the `taskId` branch of `workspace-chat.route.ts`'s `/hitl` into `answerTaskPrompt(store, threadStore, { threadId, promptId, answer })` in `tasks.handlers.ts`, preserving its stale-answer guard and the `resumePausedEntry()` original-position rule. Both `chat.route.ts` and `workspace-chat.route.ts` `/hitl` routes check the prompt payload for `taskId` first and delegate. This fixes Inbox-task HITL.

#### Mirrored prompt card

When a workspace task run raises an `ask_user` interrupt, `finalizeTurn` writes the `hitl_prompt` to the run thread (as today) and then writes a mirror `hitl_prompt` into the workspace thread with the same payload plus `runThreadId` and `sourcePromptId`, under its own `promptId`. The original records `mirrorPromptId`. `answerTaskPrompt` resolves **both** copies (via `sourcePromptId` / `mirrorPromptId`) regardless of which was answered. The answer travels through `task.resumeAnswer`, so the run resumes in its own thread either way.

#### `TaskRunView` (UI)

- `ChatRoot` (`/chat/:id`) loads thread meta; if `type === 'task'`, renders `TaskRunView` instead of the chat view.
- Header: "Automated run #N of _Task title_", status badge, trigger source, link back to the task drawer.
- Transcript via existing message components. **No composer, no retry, no fork.** HITL cards remain interactive and post to `/chat/:threadId/hitl` (now task-aware).
- `ThreadSummary.type` (UI) gains `'task'`. `GET /threads/:id` includes `taskRun: { taskId, taskTitle, runNumber, status, triggerSource }` for `'task'` threads.

#### Server-side read-only enforcement

`POST /chat/:threadId`, `POST /chat/:threadId/retry`, and `POST /threads/:id/fork` return **409** `"Automated run threads are read-only"` for `'task'` threads. The after-agent pipeline skips them.

#### Entry points

Drawer run-history rows; "open run" on mirrored markers and prompt cards; the Inbox task row's "Waiting on user" state; the sidebar queue widget's current task (links to its live run).

### 5. API and UI

#### API

- `GET /api/v1/tasks/:id/runs?limit&offset` → run records (`id`, `runNumber`, `status`, `triggerSource`, `scheduledFor`, `startedAt`, `finishedAt`, `summary`, `threadId`).
- Task responses for `cron_*` tasks include computed `schedule: { nextFireAt, iterationCount, active, inactiveReason }`, `inactiveReason ∈ disabled | failures | exhausted | expired | fired | null`.
- `POST /api/v1/triggers/cron/preview` — body `{ expression?, fireAt?, timezone }` → `{ valid, error?, description, nextFireTimes: string[3] }`. The UI takes no `cron-parser`/`cronstrue` dependency.
- "Run now" uses the existing enqueue endpoint (`trigger_source: 'manual'`); returns 409 if the task already has an active queue row (same check as the webhook handler).

#### Task drawer (`ui/src/components/task-drawer.tsx`)

- Trigger select: Manual / Webhook / Scheduled (once) / Scheduled (repeat).
- **Once:** datetime input + timezone (prefilled from `Intl.DateTimeFormat().resolvedOptions().timeZone`, editable).
- **Repeat:** expression, timezone, max iterations, stop-after date, "pause after N consecutive failures" (default 3; blank = never). Debounced (300 ms) preview call shows the human-readable description and next 3 fire times, or an inline error; Save is disabled while the preview is invalid.
- **Enabled** toggle. Inactive banner by `inactiveReason`: "Paused after 3 consecutive failures", "Finished — 10 of 10 runs", "Stopped — past Sep 30", "Fired on Sep 26 00:00".
- **Run history** list: `#13 · Scheduled · done · 2m ago` + summary line; rows open `TaskRunView`.
- Kanban: **Scheduled** column; cron cards show "next: <time>" and a last-run outcome badge.

All state via `useSignal`/`useComputed` per `ui/AGENTS.md`.

---

## Error handling

| Situation                                                          | Behaviour                                                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Invalid cron config on save                                        | 400 with field message; drawer shows inline error (preview already blocks Save).                                                            |
| Timer fires early (drift, chunking, sleep)                         | `fire()` re-checks wall clock and re-arms.                                                                                                  |
| Timer fires while task is busy / disabled                          | Skip, re-arm for next occurrence. No queued backlog.                                                                                        |
| Task deleted or trigger changed while timer armed                  | Handlers call `sync()`; `fire()` also re-reads the task and no-ops if it's gone or no longer `cron_*`.                                      |
| Registry throws in `fire()` / `sync()`                             | Caught and logged; never propagates into the request that triggered `sync()`.                                                               |
| Server down across fire time(s)                                    | One `catch_up` run on boot (D6).                                                                                                            |
| Crash mid-run                                                      | Existing `recoverRunningQueueEntries()` applies; its give-up path settles through `settleCronRun` (counts as a failure for scheduled runs). |
| Repeated scheduled failures                                        | Auto-pause at `maxConsecutiveFailures` (D8).                                                                                                |
| `read_task_run` with an unknown / other task's / unfinished run id | Tool returns an explanatory string; the run continues.                                                                                      |
| Write to a run thread (chat, retry, fork)                          | 409.                                                                                                                                        |
| Answer to a stale mirrored or original prompt                      | `answerTaskPrompt` resolves both copies and does not re-run the task (existing stale guard).                                                |

---

## Testing

Test types and tags per the root `AGENTS.md`.

### Unit (Mocha + Chai, co-located)

- `cron-schedule.test.ts` — timezone handling; no catch-up for times before `enabledAt`; DST fall-back (no double fire) and spring-forward (no skipped day); `stopAfter`; `maxIterations`; `latestMissedFireAt` returns one time for many misses; past `cron_once`.
- `settle-cron-run.test.ts` — outcome × trigger source matrix; counter increments/resets; auto-pause; exhaustion → `done`; manual runs leave counters alone.
- Trigger-config validation (Zod) incl. server-owned field protection.
- `read-task-run.tool.test.ts` — paging, footer text, rejection of foreign / unfinished / current run ids.
- Kickoff builder — with/without history, catch-up line, manual vs scheduled wording, history cap.
- `answerTaskPrompt` — resolves both copies from either side; stale-answer guard; original queue position on resume.
- `thread-text.ts` extraction (moved from `search-conversation`).

### Orchestration

- `cron-registry.test.ts` with sinon fake timers — fire at time; skip when not `scheduled`; re-arm after fire; `sync()` on edit/delete; boot catch-up fires once then arms; early-wake re-arm; >24.8-day chunking.
- `task-execution` — new run mints a thread and clears plan/outcome; resume reuses the row's thread; legacy row fallback; summary persisted; `read_task_run` bound only when a prior finished run exists.
- supertest — 409 on chat/retry/fork for `'task'` threads; `/chat/:id/hitl` on a task prompt re-enqueues instead of resuming a chat turn; `/tasks/:id/runs`; `/triggers/cron/preview`.
- Migration test (`db-migrations.test.ts`) for the new `task_queue` columns and the `thread_id` backfill of paused/running rows.

### UI (Jest)

Drawer trigger forms for each type; preview valid/invalid/loading states; Save disabled on invalid; inactive banners; run history list; `TaskRunView` renders no composer/retry/fork; Kanban `scheduled` column.

### E2E (Playwright)

- `@user-workflow` Create a Scheduled (repeat) task → preview shows description + next times → save → reopen: every field round-trips.
- `@user-workflow` Open a run from run history → transcript shown, no composer.
- `@user-workflow` Mirrored HITL card answered from the workspace chat (prompt mocked via `page.route()`), both copies show resolved.

### Evaluation (EDD — written first, failing)

New suite `suites/scheduled-task-runs.yaml`:

- `tool-sequence` — kickoff lists a previous run whose summary lacks a detail the task needs → agent calls `read_task_run` with the exact `runId` from the kickoff.
- `tool-call` (negative) — summary suffices → agent does **not** call `read_task_run`.

---

## Housekeeping

- Rewrite #72's Developer Notes to match this spec (drop R6 self-scheduling, `node-schedule`, and "no new column").
- Mark the recurring-task item in `TODO_LIST.md` complete on the implementing branch.
- `api/AGENTS.md`: document per-run threads, run records, and the cron registry.
- Update the webhook design doc's forward reference to #72.
