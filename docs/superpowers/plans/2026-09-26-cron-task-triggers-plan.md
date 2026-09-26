# Implementation plan — Cron Task Triggers (#72)

Spec: `docs/superpowers/specs/2026-09-26-cron-task-triggers-design.md` (approved).

## Context

Issue #72 asks for scheduled (`cron_once`) and recurring (`cron_repeat`) task triggers. The review found the DB columns and `TriggerType` values exist but nothing else does, and that repeated runs of one task would share a thread, plan and outcome (context bloat, stale plan). Brainstorming produced a spec that also fixes a live bug: Inbox tasks that ask the user a question can't be answered (task threads can't be opened in the UI, and `chat.route.ts` `/hitl` has no task branch).

The work ships as **two PRs**:

- **PR 1** — run records, a thread per run, kickoff history, `read_task_run`, the shared answer handler plus copied question cards, and the read-only run view. It stands alone and fixes the Inbox bug.
- **PR 2** — the `scheduled` status, cron timing and registry, settlement, catch-up, the cron API, the drawer and Kanban UI, and the eval scenarios for scheduled runs.

**Branching:** PR 1 goes on `claude/eager-turing-hyv65b`, which already carries the spec commit. PR 2 restarts the same branch from `main` after PR 1 merges, per the session's branch rules. If you want PR 2 started earlier as a stacked branch, I'll ask for permission to use a second branch name.

**Deviations from the spec, found while exploring:**

- **No sinon or supertest in the repo.** `CronRegistry` takes injected `now` / `setTimer` / `clearTimer`. Route tests use `api/tests/utilities/http-test-server.ts` `startTestServer`. No new test dependencies.
- **Tool registration.** `read_task_run` must be added to `TOOL_CATALOG` (`api/src/agents/tool-catalog.ts`), or `tool-access.middleware.ts` strips it from threaded runs. It also has to be added to `bin/eval.ts` `evalTools`.
- **Sub-agent completion lookup.** `sub-agent-notification.ts:74` uses `getTaskByThreadId()`, which assumes one thread per task. It must resolve through `task_queue.thread_id`.
- **Project close** doesn't check task statuses, so nothing to change there.
- **Spec cleanups:**
  - The Testing section's "legacy row fallback" line is stale; the migration backfill replaced it.
  - Swap the "sinon fake timers / supertest" wording for the injected clock and `startTestServer`.
  - Negative eval scenarios use the `'!read_task_run'` tool-sequence form.
- **`TODO_LIST.md`.** Per your answer, move "Trigger System" to Completed, and split Duration and Event triggers into a new outstanding item. Do this in PR 2.

---

## PR 1 — Per-run threads, run history, task questions, run view

### 1.1 Migration and store (`api/src/services/workspace-store.ts`)

- **Migration 32.** Add `task_queue.thread_id`, `summary`, `trigger_source TEXT NOT NULL DEFAULT 'manual'` and `scheduled_for`. Backfill `thread_id` for rows that are `paused` or `running`, using `COALESCE(workspaces.thread_id, tasks.thread_id)`. Update the version comment block (`:397-417`).
- **`TaskQueueEntry` / `mapQueueEntry`.** Add `threadId`, `summary`, `triggerSource` and `scheduledFor`, and a `TriggerSource` type.
- **`enqueueTask(taskId, opts?: { triggerSource?; scheduledFor? })`.** Each caller passes its source:
  - `tasks.handlers.ts` R14 / resume / enqueue: `manual`
  - `triggers.handlers.ts`: `webhook` (thread the option through `enqueueTaskHandler`)
  - `createSubAgentTask`: `agent`
  - `createTasks`: `chat`
  - `releaseEligibleDependents`: `manual`
- **New methods:**
  - `setQueueEntryThread(id, threadId)`
  - `setQueueEntrySummary(id, summary)`
  - `listTaskRuns(taskId, {limit, offset})`: newest first, computed `runNumber` by `enqueued_at`
  - `getTaskRun(runId)`
  - `getTaskRunByThreadId(threadId)`
- **`getTaskByThreadId`.** Also match `task_queue.thread_id`. This fixes the sub-agent lookup.
- **`recoverRunningQueueEntries`.** Its give-up path writes the summary `"Run failed after crash recovery"`.

### 1.2 Task execution (`api/src/agents/task-execution.ts`)

- **Thread resolution (`:95-117`).** Use `entry.threadId` if set. Otherwise create a thread with `upsertThreadOnFirstMessage(id, "<title> — run #N", 'task')`, then call `setQueueEntryThread`. Workspace tasks keep `workspaceScope`; drop the use of `workspace.threadId` and `task.threadId`.
- **Clean slate.** On a new run (no `pausedAt`, no `resumeAnswer`), call `patchTask(id, {plan:null, outcome:null})` before building the agent.
- **Summary persistence at each `completeQueueEntry` call site:**
  - accepted `complete_task` → its `summary`
  - agent trailed off → the existing message
  - generic failure → `Run failed: <category>` (from `classifyChatError`)
  - recursion limit → "Ran out of steps"
  - cancel → `Run cancelled by user`
  - thread-resolution failure → a fixed message
- **Kickoff.** New `buildRunKickoff()` in `api/src/agents/task-context.ts`, kept side-effect-free and fed plain data. It keeps the resume text and adds the run line and history block (previous run plus 3 earlier, with the exact `read_task_run({"runId":"…"})` call). `buildKickoffMessage` calls it with `listTaskRuns`.
- **Markers.** `recordTaskRunMarker` gets `runThreadId`, `runNumber` and `triggerSource` in its payload. For workspace tasks it writes to the run thread and copies to `workspace.threadId`, creating that thread the same way `:101-105` does today if missing.

### 1.3 `read_task_run` tool

- **`api/src/agents/thread-text.ts`.** Move `extractText()` here from `search-conversation.tool.ts`; both tools import it.
- **`api/src/agents/tools/read-task-run.tool.ts`.**
  - `makeReadTaskRunTool(taskId, currentRunId)`, with Zod `{runId, offset=0, limit=40 max 100}`.
  - Reads via `threadStore.getThreadMessages`, with a paging footer.
  - Returns an explanatory string for a run that is foreign, unfinished, current, or has no thread.
- **Registration.**
  - Add a `TOOL_CATALOG` entry (`alwaysOn: true`, `built-in`).
  - Bind it in `buildTaskAgent` (`chat-agent.ts:582`) only when `listTaskRuns` has a finished run with a thread. This needs the current queue entry id passed in.
  - Add it to `bin/eval.ts` `evalTools`.
- **Eval (EDD, written first).** New `suites/scheduled-task-runs.yaml`:
  - a positive `tool-sequence` scenario: the kickoff `input` lists the previous run; `argChecks` require `runId`
  - a negated `'!read_task_run'` scenario

  Model it on `suites/task-plan-progress.yaml` and `suites/task-creation.yaml:13-27`.

### 1.4 Task question routing and copied cards

- **`answerTaskPrompt(store, threadStore, {threadId, promptId, answer})`** in `tasks.handlers.ts`. It's extracted from `workspace-chat.route.ts:141-196` and keeps the stale-answer guard, `resumePausedEntry` and `wake()`. It resolves the linked copy through `sourcePromptId` / `mirrorPromptId`.
- **Both `/hitl` routes** (`chat.route.ts:74`, `workspace-chat.route.ts:122`) call `getMessage` → `taskId` → `answerTaskPrompt`.
- **Copying.** In `dispatchHitlPrompt` (`stream-handler.ts:351`), when `taskId` is set and the task has a workspace:
  - after `recordHitlPrompt`, write a copy into the workspace thread with a new `promptId`, `runThreadId` and `sourcePromptId`;
  - `updateMessage` the original with `mirrorPromptId`;
  - broadcast `hitl_prompt` for the workspace thread too.
- **`HitlPromptFields`** (`thread-message-writer.ts:202`) gets `runThreadId?`, `sourcePromptId?` and `mirrorPromptId?`.

### 1.5 Keeping run threads read-only (server side)

- `POST /chat/:threadId` and `/retry` (`chat.route.ts:30,116`), and `forkThreadHandler` (`threads.handlers.ts:156`), return 409 when `getThreadMeta(id)?.type === 'task'`.
- `afterAgentMiddleware` (`chat-agent.ts:85`) skips when the thread is `'task'`.
- `getThreadHandler` adds `taskRun: {taskId, taskTitle, runNumber, status, triggerSource}` for task threads.
- `GET /api/v1/tasks/:id/runs` (`tasks.route.ts` plus a handler).

### 1.6 UI

- **`use-thread.ts`.** Add `'task'` to `ThreadSummary.type`. `hydrate()` stores `type` and `taskRun` on the instance, as signals.
- **`ui/src/pages/chat/index.tsx` `ChatRoot`.** Render `<TaskRunView/>` when `thread.type === 'task'`.
- **New `ui/src/components/task-run-view.tsx`:**
  - header (run number, task title, status, trigger source, link to the task)
  - messages through `ThreadMessageItem`, with no `onRetry` / `onFork`
  - pending `HitlPromptMessage` cards
  - no `ChatInput`
- **`types/thread-message.ts`.** Add `taskId?`, `runThreadId?` and `sourcePromptId?` to `hitl_prompt`; `runThreadId?`, `runNumber?` and `triggerSource?` to `task_run_marker`.
- **`task-run-marker-message.tsx`.** "Scheduled run #N" or "Run #N" label, plus an "open run" link. `hitl-prompt-message.tsx` gets an "open run" link when `runThreadId` is set.
- **`tasks-api.ts`.** A `TaskRun` type and `fetchTaskRuns()`.
- **`task-drawer.tsx`.** A Run history section (between Trigger and Tracker, `:1015`), with rows linking to `/chat/<threadId>`. The `waiting_on_user` banner (`:792`) links to the latest run instead of "Go to chat" for Inbox tasks.
- **`thread-sidebar.tsx` queue widget.** The current task links to its live run.

### 1.7 PR 1 tests

- **Unit:**
  - `thread-text`
  - `read-task-run.tool` (paging, footer, rejections)
  - `buildRunKickoff` (history, cap, resume, manual wording)
  - `answerTaskPrompt` (both copies, stale guard, original position)
  - store `listTaskRuns`, `getTaskByThreadId` through a run thread, summary writes
- **Orchestration:**
  - `task-execution.test.ts`: new run creates a thread and clears the plan; resume reuses the thread; summary persisted; marker copy
  - `db-migrations.test.ts`: new columns, and the backfill of paused/running rows
  - routes through `startTestServer`: 409s on task threads; `/chat/:id/hitl` re-queues a task prompt; `/tasks/:id/runs`
- **Jest:** `ui/test/task-run-view.test.tsx` (no composer / retry / fork; HITL card present); drawer run history; marker link.
- **E2E (`e2e/tests/task-runs.spec.ts`, `@user-workflow`, not `@llm`):** mock `GET /api/v1/threads/:id` and `/tasks/:id/runs` with `page.route()`:
  - open a run from the drawer → transcript shown with no composer
  - a copied question card in the workspace chat, answered → both copies resolved

  Add new testids to the table in `e2e/AGENTS.md`.

- **Docs:** `api/AGENTS.md` note on run threads and run records. Fix the spec's stale lines.

---

## PR 2 — Scheduling

### 2.1 Dependencies

`npm install -w api cron-parser@^5 cronstrue`. Nothing is added to the UI.

### 2.2 `scheduled` status

- **API:** add to `TaskStatus` (`workspace-store.ts:90`).
- **UI:**
  - `tasks-api.ts:3`
  - the `STATUS_LABELS` records (`task-drawer.tsx:65`, `[id].tsx:43`)
  - `use-tasks.ts:115` `groupTasksByStatus`
  - Kanban: `COLUMN_ORDER` (`[id].tsx:61`, between pending and ready), colour chain `:84-106`, `repeat(7…)`→8 at `:331`
- **Dependencies.** `addTaskDependencyHandler` (`tasks.handlers.ts:348`) rejects a target that is a `cron_repeat` task.

### 2.3 Timing and config (pure functions)

- **`api/src/services/cron-schedule.ts`:** `nextFireAt`, `latestMissedFireAt` and `describe`, using `cron-parser` v5 with `tz`, and `cronstrue`.
- **`api/src/services/cron-config.ts`:** Zod schemas for `CronOnceConfig` and `CronRepeatConfig` (IANA check via `Intl.supportedValuesOf('timeZone')`), plus `resolveCronConfig(current, incoming, now)`, which:
  - enforces server-owned fields (`enabledAt`, `consecutiveFailures`, `lastFiredAt`, `pausedReason`);
  - on re-enable, sets `enabledAt = now` and resets the counters.
- **`resolveTriggerConfig`** (`tasks.handlers.ts:53`) delegates to it and returns 400 on invalid config. On create/patch the status becomes `scheduled` if enabled, `pending` if disabled.

### 2.4 Registry and settlement

- **`api/src/services/cron-registry.ts`:** `CronRegistry({ now, setTimer, clearTimer })` with `sync`, `fire`, `boot` and `stop`, following the spec §2. Delays over 24.8 days are split into chunks. Every error is caught and logged. It also has `bootCronRegistry()` / `getCronRegistry()`.
- **`fire` goes through `store.fireCronTask(taskId, scheduledFor, source)`,** which does the gate check, `lastFiredAt`, the status change to `ready` and `enqueueTask({triggerSource, scheduledFor})` in one transaction, then calls `wake()`.
- **`settleCronRun`** (`api/src/services/cron-settlement.ts`) is called from `completeQueueEntry` for `cron_*` tasks in place of the plain status write, following the spec's matrix. The registry `sync` runs afterwards from the caller side (task-execution / routes), which keeps the store free of any registry import.
- **Callers of `listScheduledTasks()`, `sync()` and boot:**
  - `index.ts`: `bootCronRegistry().boot()` after `bootTaskScheduler`
  - task create / patch / delete routes
  - workspace delete
  - after `executeTask` settles

### 2.5 Cron API

- `POST /api/v1/triggers/cron/preview` (`triggers.route.ts`).
- Task responses gain a `schedule` field `{nextFireAt, iterationCount, active, inactiveReason}`, built by a helper used in the task handlers.
- "Run now" is the existing `/tasks/:id/enqueue`, which returns 409 if a run is already active (reuse the check from `triggerWebhookHandler`).

### 2.6 Drawer UI (`task-drawer.tsx`)

- **Trigger options** (`:972`): add Scheduled (once) and Scheduled (repeat).
- **New subcomponents:**
  - `ui/src/components/cron-once-fields.tsx` and `cron-repeat-fields.tsx`: signals only; timezone prefilled from the browser; preview requested 300 ms after typing stops.
  - `schedule-status-banner.tsx`: the enabled toggle and the inactive-reason banner.
- **`handleSave`** (`:539`) sends `triggerConfig`, and Save is disabled while the preview is invalid.
- **Kanban card:** "next: …" and the last run's result badge.
- **Inbox:** `TaskRow` shows a readable trigger label.
- **Sidebar:** the inbox count (`thread-sidebar.tsx:268`) stays pending + ready.

### 2.7 PR 2 tests

- **Unit:**
  - `cron-schedule` (time zones, both daylight-saving transitions, `stopAfter`, `maxIterations`, a single catch-up time, `enabledAt` bound, `cron_once` in the past)
  - `cron-config` (validation, server-owned fields, re-enable)
  - `cron-settlement` (the outcome × source matrix, auto-pause, exhausted, manual runs)
  - the `scheduled`-target dependency rejection
- **Orchestration:** `cron-registry.test.ts` with an injected fake clock and timer:
  - fires at the right time
  - skips when the task isn't `scheduled`
  - re-arms after firing
  - `sync` on edit and delete
  - boot catch-up fires once
  - early wake re-arms
  - long delays are chunked
- **Routes:** the preview endpoint, 400 on invalid config, `schedule` on task responses, 409 from Run now.
- **Jest:** the trigger forms, preview states, disabled Save, inactive banners, the Kanban `scheduled` column (`task-card.test.tsx`).
- **E2E:** extend `e2e/tests/inbox-tasks.spec.ts`. Create a Scheduled (repeat) task, check the preview, save, reopen and check every field survives. Kanban `scheduled` column in `task-kanban.spec.ts`.
- **Eval:** add a catch-up kickoff scenario to `scheduled-task-runs.yaml`.
- **Docs and housekeeping:**
  - `TODO_LIST.md`: move Trigger System to Completed and add a new outstanding item for Duration and Event triggers.
  - `api/AGENTS.md`: cron registry.
  - Update the webhook spec's pointer to #72.
  - Rewrite #72's developer notes. Needs your go-ahead, since it's outward-facing.

---

## Reuse (don't reimplement)

- Enqueue and dedup: `enqueueTaskHandler` / `triggerWebhookHandler` (`tasks.handlers.ts:182`, `triggers.handlers.ts:18`).
- Answering questions: the existing branch at `workspace-chat.route.ts:141-196`, `resolveHitlPrompt` (`thread-message-writer.ts:237`), `resumePausedEntry`.
- Transcript text: `extractText` (moved). Paging: `threadStore.getThreadMessages` (`thread-store.ts:465`).
- Boot and singleton pattern: `bootTaskScheduler` / `getTaskScheduler` (`task-scheduler.ts:120`).
- Test harnesses:
  - `mkdtemp` + `openDatabase` + `bootWorkspaceStore` (`task-scheduler.test.ts:24`)
  - `startTestServer` (`api/tests/utilities/http-test-server.ts`)
  - Jest module mocks (`ui/test/task-drawer.test.tsx:1-29`)
  - Playwright hydration mocks (`e2e/tests/hitl-shell-approval.spec.ts`)
- Message rendering: `ThreadMessageItem` (omit `onRetry` / `onFork`), `HitlPromptMessage`.

## Verification (each PR)

1. `npm run lint`, `npx prettier --check .` and `npm test` from the repo root must be green before every commit (AGENTS.md).
2. `npm run test:e2e:ci`.
3. Eval, written first: `npm run eval -- --suite scheduled-task-runs --model ollama --judge-model ollama`. It fails before the tool and kickoff changes and passes after, where a local Ollama is available. If it isn't available in this container, I'll say so rather than claim a pass.
4. **PR 1, manual (via the `run` skill):**
   - Create an Inbox task that calls `ask_user`, run it, open the run from the drawer, answer, and confirm the task finishes.
   - For a workspace task, answer the copied card in the workspace chat.
   - Run a task twice and confirm the second run's kickoff lists the first run and the agent can call `read_task_run`.
5. **PR 2, manual:**
   - Create a `*/1 * * * *` repeating task, watch it fire, go back to Scheduled, and increment the count.
   - Force failures and confirm it auto-pauses at 3.
   - Restart the API across a fire time and confirm exactly one catch-up run.
   - Create a `cron_once` a minute out and confirm it fires once.
6. After each push: open the PR (template-driven), subscribe to PR activity, and drive CI to green.
