# Chat-Created Scheduled Tasks — Design

**Date:** 2026-10-01
**Status:** Draft
**Related:** [Issue #240](https://github.com/tkottke90/amazing-hashbrown/issues/240), [Cron Task Triggers design](./2026-09-26-cron-task-triggers-design.md) (Issue #72)

---

## Goal

Let a user ask the chat agent, in plain language, to create a task on a recurring (`cron_repeat`) or future-dated (`cron_once`) schedule, and have the agent actually create one — instead of silently creating a plain one-shot task and narrating a schedule that was never set.

## Problem

`cron_once`/`cron_repeat` triggers exist end-to-end for the REST API (Issue #72), but the only task-creation tool bound to chat, `create_tasks` (`api/src/agents/tools/create-tasks.tool.ts`), has no trigger/cron fields at all and hard-codes `triggerType: 'chat'` on every task. Its batch insert path, `WorkspaceStore.createTasks()`, unconditionally forces any dependency-free task to `status: 'ready'` and enqueues it immediately — there is no branch anywhere in this path for "don't run this now, wait for its schedule." Because the agent has no way to know this limitation exists, it invents a schedule in its reply while the backend quietly creates (and immediately runs) a one-off task.

Two further gaps surfaced during design:

- `releaseEligibleDependents()` — the single function that resolves every dependent task in the app once its blocking task clears — has the same hard-coded `ready` + `enqueueTask()` behavior, with no cron awareness. Supporting a cron task that waits on a batch dependency means branching this shared function too.
- There is no stored notion of a default timezone anywhere in the backend. The task drawer UI prefills it from the browser; the chat agent has no browser context to draw from.

## Decisions (and why)

| #   | Decision                                                                                                                                                                                        | Rationale                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Extend `create_tasks`'s existing schema with an optional per-task `trigger` field, rather than a new dedicated tool.                                                                            | A new `schedule_task` tool can't participate in the batch's `dependsOnIndexes` graph (D3 needs cross-task dependencies), so it would end up duplicating `create_tasks`'s batch/dependency machinery.       |
| D2  | Reuse `resolveCronConfig`/`CronOnceInputSchema`/`CronRepeatInputSchema` (`cron-config.ts`) for validation — no new cron-validation logic.                                                       | This is the exact function the REST API already uses; a second implementation risks disagreeing with it (the same reasoning the cron design doc gave for picking one `nextFireAt()`).                      |
| D3  | A cron-triggered task **can** participate in `dependsOnIndexes`. When its dependency clears, it lands in `'scheduled'` instead of `'ready'`+enqueued.                                           | Explicit product requirement: "create one task now, and a recurring task that only starts once the first succeeds" is a real workflow shape, not a hypothetical.                                           |
| D4  | The store stays registry-free. `create-tasks.tool.ts`'s handler calls `getCronRegistry().resyncAll()` once after a batch with any trigger, rather than the store calling the registry directly. | `cron-registry.ts` imports `workspace-store.ts` — the reverse import would be circular. `resyncAll()` already exists and is cheap (re-arms timers from DB state); no new plumbing needed.                  |
| D5  | Add an app-wide default timezone (`AppConfigSchema.timezone`, default `'UTC'`), consumed as the default inside `cron-config.ts`'s own input schemas.                                            | One source of truth for "what timezone did they mean" across REST, UI, and chat, instead of a chat-tool-only special case the REST API doesn't share.                                                      |
| D6  | Validate every task's `trigger` before any DB write; one bad schedule rejects the whole batch.                                                                                                  | Matches `create_tasks`'s existing title-validation loop and the file's documented "all rows land or none do" transaction guarantee — no partial batches.                                                   |
| D7  | The tool's response carries a computed schedule description (via `describeSchedule()`, the same function the REST cron-preview endpoint uses) for each scheduled task.                          | Gives the agent ground-truth text to relay instead of composing its own description of a schedule it can't otherwise verify — directly targets the issue's "agent narrates a schedule that isn't real."    |
| D8  | A new eval scenario in `suites/task-creation.yaml`, written to fail first, plus a new paragraph in `CREATE_TASKS_SECTION` (`system-prompt.ts`).                                                 | Required by `AGENTS.md`'s Evaluation-Driven Development rule for any new LLM-facing behavior; this file already has precedent (`trackerUrl` was added the same way after an eval caught it being dropped). |
| D9  | A new `@llm @local` Playwright suite exercises the real pipeline (real chat → real `CronRegistry` timer → real task execution), following `CreateTasks.ts`'s existing manual-suite pattern.     | Tool-calling/scheduling behavior under a real model, and a schedule actually firing in wall-clock time, are not practical to cover with `page.route()` mocks or unit tests.                                |

## Non-goals

- Changing anything about REST-created or UI-created scheduled tasks — this only adds a new path for chat to reach the same `cron_once`/`cron_repeat` machinery.
- A per-user or per-workspace timezone. D5's default is server-wide; a user-level override is a separate feature if it's ever needed.
- Webhook triggers from chat — out of scope; the issue and this design are about `cron_once`/`cron_repeat` only.
- Changing `statusForSavedSchedule`, `settleCronRun`, `describeSchedule`, or any other already-shipped cron-config/cron-schedule logic. Every piece of cron business logic here is reused, not modified.

## Design

### 1. Schema & tool contract

`CreateTasksSchema` (`api/src/agents/tools/create-tasks.tool.ts`) gains an optional per-task `trigger` field:

```ts
trigger: z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('cron_once'),
      fireAt: z.string().describe('ISO 8601 date-time this task should run once, in the future.'),
      timezone: z
        .string()
        .optional()
        .describe('IANA time zone, e.g. "America/Chicago". Defaults to the server-configured timezone if omitted.'),
    }),
    z.object({
      type: z.literal('cron_repeat'),
      expression: z.string().describe('Standard 5-field cron expression, e.g. "*/1 * * * *" for every minute.'),
      timezone: z.string().optional(),
      maxIterations: z.number().int().positive().nullable().optional(),
      stopAfter: z.string().nullable().optional(),
      maxConsecutiveFailures: z.number().int().positive().nullable().optional(),
    }),
  ])
  .optional()
  .describe(
    'Omit for a plain one-shot task that runs immediately once queued (today\'s default behavior). ' +
      'Set this to give the task a recurring or future-dated schedule instead. Only describe a task as ' +
      'scheduled/recurring in your reply when this field was actually set and accepted.',
  ),
```

A task created with `trigger` set is never enqueued immediately — it becomes a `'scheduled'` task, the same status and lifecycle a REST-created cron task already has (see the cron design doc's D7).

### 2. Validation semantics

Before any insert, the handler iterates every task in the batch. For each with a `trigger`, it calls the existing `resolveCronConfig(type, null, { ...fields }, now)` from `cron-config.ts` — the exact function `createTaskHandler`/`patchTaskHandler` already call for the REST API. Any failure (bad cron expression, invalid timezone, `fireAt` in the past, etc.) aborts the **entire** batch with `Task N: <message>. No tasks were created.`, matching the existing per-task title-validation loop's style (`create-tasks.tool.ts:68-72`) and the file's documented all-or-nothing transaction guarantee. No task is created, and no cron registry sync happens, on any validation failure.

### 3. Status & cron-registry wiring

**`WorkspaceStore.createTasks()`**: today, a zero-dependency task is unconditionally patched to `status: 'ready'`/`assignedTo: 'agent'` and enqueued. This gains a branch: a task with a resolved cron `triggerConfig` is instead patched via `statusForSavedSchedule('pending', type, config, 0, now)` (reused from `cron-config.ts`) — resolving to `'scheduled'` for any newly created, enabled schedule — and is **not** enqueued. Cron tasks only ever enter `task_queue` when `CronRegistry` fires them.

**`releaseEligibleDependents()`**: the same branch is added here. When a dependent task becomes eligible (`isTaskReady()`), if it carries a cron trigger it takes the `statusForSavedSchedule` path instead of `ready`+`enqueueTask()`. This is what makes scenario D3 work: a cron task with `dependsOnIndexes` stays at `'pending'` until its dependency resolves, then becomes `'scheduled'` — exactly like an ordinary dependent becomes `'ready'`, just landing in a different status.

**Registry sync**: the store stays registry-free (existing convention — "Handlers themselves stay registry-free so they remain unit-testable"). `create-tasks.tool.ts`'s handler calls `getCronRegistry().resyncAll()` once after `s.createTasks(inputs)` returns, if any task in the batch carried a `trigger`. This covers both the immediate-scheduling case and the dependency case in one call, at the one point in this flow that already has access to both the store and the registry.

### 4. Server-level default timezone

`AppConfigSchema` (`api/src/config/env.ts`) gains `timezone: z.string().default('UTC')`, exposed as `env.timezone`. An invalid configured value logs a warning at startup and falls back to `'UTC'` rather than failing to boot.

Rather than every caller re-implementing the fallback, `CronOnceInputSchema`/`CronRepeatInputSchema` (`cron-config.ts`) change their `timezone` field from required to `.default(() => env.timezone)`. This is a single, centralized change: REST requests that already send a timezone are unaffected; the chat tool (and any future caller) that omits it gets the same default the rest of the app uses.

### 5. Teaching the agent, and EDD

Per `AGENTS.md`'s Evaluation-Driven-Development rule, a new eval scenario is added to `suites/task-creation.yaml` first, reproducing the issue's own repro: a chat request for a recurring or future-dated task should result in `create_tasks` being called with a `trigger` matching what was asked, and the agent's reply text should describe the real resolved schedule (via `tool-call` assertions plus a `responseRubric`). This scenario is written and confirmed failing against today's code before any implementation changes land.

`CREATE_TASKS_SECTION` in `system-prompt.ts` gets a new paragraph: it teaches that `trigger` exists and the difference between `cron_once` and `cron_repeat`, and states the hard rule the issue is about — the agent may only describe a task as scheduled or recurring when the tool's own response confirms a schedule was actually set; if `trigger` was omitted, the created task is a plain one-shot and must be described as such.

### 6. Tool response shape

For every task created with a `trigger`, the tool's JSON response includes a computed schedule block built from `describeSchedule(cronTiming(type, config), now)` (`cron-schedule.ts`) — the same function `previewCronHandler` already uses for the task drawer's live preview:

```json
{
  "created": [
    {
      "id": "...",
      "title": "...",
      "schedule": { "description": "Every minute", "nextFireAt": "2026-10-01T21:35:00.000Z" }
    },
    { "id": "...", "title": "..." }
  ]
}
```

A task with no `trigger` carries no `schedule` key, keeping today's response shape unchanged for plain tasks.

## Testing

### Developer tests

- `create-tasks.tool.test.ts`: valid `cron_once`/`cron_repeat` creation (resulting status `'scheduled'`, no queue row, response includes `schedule`); invalid cron expression/timezone/past `fireAt` (whole batch rejected, nothing created, `resyncAll()` not called); `trigger` + `dependsOnIndexes` together (task stays `'pending'` until the dependency clears, then becomes `'scheduled'`); `resyncAll()` called iff at least one task in the batch had a trigger.
- `workspace-store.test.ts`: the new branches in `createTasks()` and `releaseEligibleDependents()`.
- `env.test.ts` (or wherever `AppConfigSchema` is tested): the new `timezone` field's default and invalid-value fallback.
- `cron-config.test.ts`: `CronOnceInputSchema`/`CronRepeatInputSchema` defaulting an omitted `timezone` to `env.timezone`.

### Evaluation (EDD)

- New scenario(s) in `suites/task-creation.yaml` per §5, confirmed failing before implementation, run to green via `npm run eval -- --suite task-creation` before merge.

### E2E — new `@llm @local` suite

A new suite, sibling to `e2e/tests/workspace/CreateTasks.ts` and following the same `@tkottke90/playwrite-test-runner` pattern (manual, real dev server, real LLM, never run via `npm run test:e2e*`), covers:

1. **Immediate-fire cron succeeds.** A chat request results in a `cron_once`/`cron_repeat` task scheduled a few seconds out. The test waits (bounded, polling the task card's status — not a fixed sleep) for the real `CronRegistry` to fire it, the real LLM to run it, and the card to reach `done`.
2. **Immediate-fire cron needs approval.** Same setup, but the scheduled run's own task requires a HITL-gated tool call. The test asserts the task lands in `waiting_on_user` with the real question surfaced, resolves it through the UI, and confirms it completes.
3. **Cron gated on a sibling task's success.** One chat message creates both tasks in a single `create_tasks` batch — a plain task at index 0, a cron task depending on index 0. The test asserts the cron task is not `'scheduled'` (no next-fire time shown) until the plain task's real run finishes successfully, then asserts it flips to `'scheduled'` — the direct end-to-end proof of the §3 dependency branch.

These exercise the full pipeline no unit test can: real chat → real tool call → real `CronRegistry` timer → real task execution → real status transitions.
