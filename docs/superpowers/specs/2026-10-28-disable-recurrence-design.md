# Disable Recurrence — Design

Fixes [#360](https://github.com/tkottke90/amazing-hashbrown/issues/360): a `cron_repeat` task has no way to stop its own future fires once the one-time work it was recurring for is done, so it keeps re-firing a no-op re-verification indefinitely (112 of 194 runs in the retrospective workspace that surfaced this).

See `GLOSSARY.md`'s "Cron Task Recurrence" section for **Recurrence** and **Disable Recurrence** — this spec doesn't restate those definitions. See `docs/adr/0045-self-disabled-recurrence-lands-in-done-lane.md` for why the board-lane choice below isn't the obvious one.

## New tool: `disable_recurrence`

- File: `api/src/agents/tools/disable-recurrence.tool.ts`, following `makeCompleteTaskTool`'s per-run factory pattern (built fresh per task run, closed over `taskId`).
- Schema: no required parameters. The agent's companion `complete_task` call already requires a `summary`, which is the durable record of _why_ — `disable_recurrence` doesn't duplicate it.
- Behavior:
  1. Read the task's current `triggerConfig`. If `enabled` is already `false` (whatever the existing `pausedReason` — a human's manual pause, a prior `consecutive_failures` auto-pause, or an earlier `disable_recurrence` call), return a friendly no-op message ("Recurrence is already off.") and change nothing. Never overwrite an existing `pausedReason`.
  2. Otherwise, patch `triggerConfig` to `{ ...current, enabled: false, pausedReason: 'no_further_runs_needed' }` via `store.patchTask`.
  3. Call `getCronRegistry().sync(taskId)` immediately, per `api/AGENTS.md`'s rule that anything changing a cron task's trigger must resync the registry.
  4. Return a short confirmation string.
- No changes needed in `settleCronRun()` (`api/src/services/cron-settlement.ts`): its existing `if (!config.enabled) return { status: 'pending', config }` branch already produces the right `TaskStatus` once a run settles, and already carries the `pausedReason` through unchanged.

## Binding — only for `cron_repeat` tasks

In `buildTaskAgent` (`api/src/agents/chat-agent.ts`), add the tool conditionally, following the same pattern already used for `read_task_run`:

```ts
...(task.triggerType === 'cron_repeat' ? [makeDisableRecurrenceTool(task.id)] : []),
```

Never bound for `manual`, `chat`, `cron_once`, or `webhook` tasks, and never bound outside `buildTaskAgent` (not in interactive chat, workspace chat, or sub-agent runs).

## Type and config changes

- `api/src/services/cron-config.ts`: `CronRepeatConfig.pausedReason` widens from `'consecutive_failures' | null` to `'consecutive_failures' | 'no_further_runs_needed' | null`.
- `api/src/services/cron-config.ts`: `ScheduleInactiveReason` gains `'completed'`. `describeTaskSchedule`'s `cron_repeat` branch maps `pausedReason === 'no_further_runs_needed'` to `'completed'` (alongside its existing `'consecutive_failures'` → `'failures'` mapping; anything else falls through to today's generic `'disabled'`).
- `ui/src/services/tasks-api.ts`: mirror both widened types (`pausedReason`, `ScheduleInactiveReason`) to match the API shape.
- `ui/src/lib/cron-drafts.ts`: `inactiveScheduleMessage` gains a `case 'completed':` returning _"Finished — the agent determined no further runs are needed."_
- `api/src/services/board-rules.ts`: `FINISHED_SCHEDULE` gains `'completed'`, so `isScheduleFinished` routes the task to the `done` lane (see ADR-0045).

## Out of scope

- No harness-side text heuristic on task goal/description text — this ships the explicit tool only.
- No change to `complete_task` or `update_plan` — neither tool touches `triggerConfig`, and this feature doesn't change that.
- No change to how a human manually disables/re-enables a schedule via `PATCH` — `resolveCronConfig`'s existing `pausedReason: turnedOn ? null : (prev?.pausedReason ?? null)` already clears any `pausedReason` (including the new one) on re-enable, with no code change needed.

## Testing

Per the root `AGENTS.md` testing rules, all of the following ship in the same PR:

- **Unit**: `disable-recurrence.tool.test.ts` — already-disabled no-op (and that it doesn't clobber an existing `pausedReason`), successful disable patches `triggerConfig` and calls the registry sync.
- **Unit**: `cron-settlement.test.ts` — a run settling with `enabled: false, pausedReason: 'no_further_runs_needed'` already in the config yields `status: 'pending'` with that `pausedReason` intact (should need no new production code, just a confirming test).
- **Unit**: `cron-config.test.ts` — `describeTaskSchedule` maps the new `pausedReason` to `inactiveReason: 'completed'`.
- **Unit**: `board-rules.test.ts` — a `pending` cron task with `inactiveReason: 'completed'` lands in the `done` lane.
- **Orchestration**: `chat-agent.test.ts` (or equivalent) — `disable_recurrence` is bound for a `cron_repeat` task and absent for `manual`/`chat`/`cron_once`/`webhook` tasks.
- **Jest** (ui): `cron-drafts.test.ts` — new banner sentence for `'completed'`.
- **E2E**: the drawer banner and board lane are UI-visible behavior changes, so per the root `AGENTS.md` they need Playwright coverage — mock a `cron_repeat` task whose schedule response carries `inactiveReason: 'completed'` and assert the banner text and `done`-lane placement (`page.route()` mock per `e2e/AGENTS.md`, since reaching this state live would require a real agent run).
