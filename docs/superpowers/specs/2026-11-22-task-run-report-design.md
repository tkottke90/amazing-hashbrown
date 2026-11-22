# Task Run Report & Runs-to-Complete Metric

## Context

Autonomous tasks (`tasks` + `task_queue`) already loop over multiple **runs**
before reaching a terminal state — the user's own observation is that most
tasks take 3-4 runs to complete. Today there is no standalone view of a
single task's run history: the closest thing is `TaskRunRetrospective`, a
per-task slice embedded inside `buildWorkspaceRetrospective`
(`lib/workspace-reports`), which gives the same evidence a Thread Report
gives for one turn, but only reachable bundled inside a whole-workspace
retrospective — and only for tasks that belong to a workspace. `Task.workspaceId`
is nullable (tasks created from chat, a webhook, or a cron trigger with no
workspace exist and are invisible to `buildWorkspaceRetrospective` entirely),
so a true standalone report cannot be built by slicing one task out of that
existing function.

This spec adds:

1. A standalone **Task Run Report** — one task's full run history, in the
   same spirit as a Thread Report, reachable for any task regardless of
   workspace.
2. A **runs-to-complete** metric — how many runs it took a task to reach
   `done` — surfaced both on that task's own report and as a system-wide
   dashboard aggregate, so changes to the system can be judged by whether
   this number moves.

## Goals

- A per-task report, equivalent in spirit to a Thread Report but covering
  every run of a task, reachable independent of any workspace.
- A `runsToComplete` value on that report for the task itself.
- A system-wide "average runs to complete" dashboard metric, plus a
  "non-completion rate" dashboard metric, so the two numbers can be read
  together (a falling average that's actually driven by more tasks being
  abandoned early would be a false improvement).
- No duplicated "compute anomalies for a task's runs" logic between the new
  report and the existing Workspace Retrospective.

## Non-goals

- No LLM-generated narrative for the Task Run Report (unlike the Workspace
  Retrospective's optional one-shot narrative) — this report is purely
  factual.
- No historical trend graph for the dashboard metrics in this iteration —
  `big-number` only; a `line-graph` version is a later enhancement.
- No change to how a task's status or a run's outcome is determined — this
  spec only reads existing state, it doesn't change task/run lifecycle logic.

## Design

### 1. New store query

Add `WorkspaceStore.listTaskProgressEntriesForTask(taskId: string):
TaskProgressEntryLike[]` — a per-task equivalent of the existing
`listTaskProgressEntriesForWorkspace(workspaceId)`. Every other query the
new report needs (`listTaskRuns`, `failedRunStreaks`, `handedOffRunCounts`,
and `@tkottke90/thread-reports`' `buildThreadReport`) already takes a
`taskId`/`threadId` and needs no workspace context.

### 2. New package: `lib/task-run-reports`

Mirrors the existing `thread-reports`/`workspace-reports` conventions: pure
functions, no DB writes, structurally-typed store interfaces (duplicated,
not imported, same convention `ThreadStoreLike`/`WorkspaceStoreLike` use), a
Nunjucks template for HTML rendering.

```
lib/task-run-reports/src/types.ts   TaskRunReportData, TaskRunReportStoreLike
lib/task-run-reports/src/build.ts   buildTaskRunReport(taskId, stores, options)
lib/task-run-reports/src/render.ts  renderTaskRunReportHtml(data)
lib/task-run-reports/templates/report.njk
lib/task-run-reports/test/unit/build.test.ts
lib/task-run-reports/test/unit/render.test.ts
```

`buildTaskRunReport(taskId, stores, options)` returns `TaskRunReportData |
null` (null only if the task itself doesn't exist):

```ts
interface TaskRunReportData {
  taskId: string;
  generatedAt: string;
  task: TaskLike; // title, status, origin, provider, model, workspaceId
  runs: TaskRunRetrospective[]; // reused shape: runId, runNumber, status,
                                 // summary, recoveryAttempts, threadReport
  anomalies: Anomaly[]; // reused Anomaly union from workspace-reports
  handoff: HandoffSummary | null; // reused shape, singular (one task, not a list)
  progressEntries: TaskProgressEntryLike[];
  summary: {
    runCount: number;
    failureCount: number;
    wikiWriteCount: number;
    anomalyCount: number;
  };
  // Count of this task's runs up to and including the one that reached
  // 'done', or null if the task hasn't reached 'done' yet.
  runsToComplete: number | null;
}
```

Per run, `threadReport` reuses `buildThreadReport` exactly as
`workspace-reports` does today. Anomaly detection reuses the same three
kinds already defined in `lib/workspace-reports/src/types.ts`
(`repeated_failures`, `wiki_mismatch`, `recursion_escalation`):

- `repeated_failures` / `recursion_escalation`: computed exactly as today —
  already task-scoped, no workspace needed.
- `wiki_mismatch`: only computed when the task has a `workspaceId` whose
  workspace has a `wikiId`; skipped entirely for a workspace-less task (no
  wiki to mismatch against).

`runsToComplete` is `listTaskRuns(taskId).length` when `task.status ===
'done'`, else `null`.

### 3. `workspace-reports` refactor

`buildWorkspaceRetrospective`'s inline per-task loop (currently lines
107-157 of `lib/workspace-reports/src/build.ts`, which independently computes
`repeated_failures`/`recursion_escalation`/handoff logic per task) is
replaced with a call to `buildTaskRunReport` per task. The workspace-level
anomaly list becomes the chat thread's anomalies plus
`tasks.flatMap(t => t.anomalies)`. `TaskRetrospective` keeps its existing
shape; `TaskRunRetrospective`/`Anomaly`/`HandoffSummary` types are shared
between the two packages rather than redefined.

This is a refactor, not a behavior change: `buildWorkspaceRetrospective`'s
existing test suite (`lib/workspace-reports/test/unit/build.test.ts`) must
pass unmodified against the refactored implementation.

### 4. Metric computation

One new store aggregate, since the two new dashboard metrics are two views
of the same underlying counts:

```ts
interface TaskCompletionStats {
  avgRunsToComplete: number | null; // avg task_queue-row-count per task,
                                     // over tasks with status='done';
                                     // null if none yet
  completedTaskCount: number;
  nonCompletionRate: number | null; // (failed+cancelled) / (done+failed+cancelled);
                                     // null if no terminal tasks yet
  terminalTaskCount: number;        // done + failed + cancelled
}
```

`WorkspaceStore.taskCompletionStats(): TaskCompletionStats` computes this in
one query. A task in any non-terminal status (`pending`, `scheduled`,
`ready`, `running`, `waiting_on_user`, `blocked`) is excluded from both the
numerator and denominator of both metrics — counting an in-progress task's
current run count would bias the average downward and make before/after
comparisons unreliable (an open task is sampled mid-flight, before it's
shown its true eventual value).

Two new files under `api/src/services/metrics/`, each a thin wrapper around
`taskCompletionStats()`, following the existing `Metric` registry pattern
(`id`, `label`, `displayType`, `resolve({workspaceStore, ...})`):

- `avg-runs-to-complete.metric.ts` — `displayType: 'big-number'`, `value:
  stats.avgRunsToComplete ?? 0`, `unit: 'runs'`.
- `task-non-completion-rate.metric.ts` — `displayType: 'big-number'`,
  `value` as a percentage (`stats.nonCompletionRate` scaled to 0-100, or `0`
  when `terminalTaskCount` is `0`), `unit: '%'`.

A trend-over-time (`line-graph`) version of either metric is deferred to a
future iteration.

### 5. API route

`GET /api/v1/tasks/:id/report` — a `getTaskRunReportHandler` in
`api/src/routes/v1/tasks.handlers.ts`, following the same
`HandlerResult`/plain-handler-function pattern as the existing
`getThreadReportHandler` for threads: 404 if the task doesn't exist,
otherwise calls `buildTaskRunReport(taskId, stores)` and renders the result
via `renderTaskRunReportHtml`, returned as `text/html`. Registered in
`tasks.route.ts` as `router.get('/:id/report', ...)`.

### 6. UI

A new `TaskReportButton` component (`ui/src/components/`), mirroring
`ThreadReportButton`'s pattern exactly: `window.open('/api/v1/tasks/${task.id}/report',
'_blank')`.

Placed in `task-drawer.tsx`'s form footer row (currently `Cancel` as
`variant="ghost"` and `Save changes`/`Create task` as the default button),
`variant="outline"` so it visually contrasts with both, labeled "Task
Report". Rendered only when `!isNew && task` — a brand-new, unsaved task has
no runs yet, so there's nothing to report on.

## Error handling & edge cases

- Unknown task id → 404, same as the thread report handler.
- Task with zero runs (never started) → report renders with an empty runs
  list, `runsToComplete: null`, no anomalies.
- Workspace-less task → `wiki_mismatch` anomaly detection is skipped
  entirely; `repeated_failures` and `recursion_escalation` still apply.
- A run with no `threadId` (queued, never started) → `threadReport: null`
  for that run, same handling as today's `workspace-reports`.
- Zero completed tasks ever → `avg-runs-to-complete` returns `0`, not
  `NaN`/an error (matches the existing `project-count` metric's plain-zero
  convention). Same for `task-non-completion-rate` with zero terminal tasks.

## Testing

- `lib/task-run-reports/test/unit/build.test.ts` — no runs, multiple runs,
  workspace vs. workspace-less task, each anomaly kind, `runsToComplete`
  computed vs. `null`.
- `lib/task-run-reports/test/unit/render.test.ts` — template rendering,
  mirroring `thread-reports`' render tests.
- `lib/workspace-reports/test/unit/build.test.ts` — existing tests pass
  unmodified against the refactored implementation (proves the refactor is
  behavior-preserving at the workspace level).
- `api/src/services/workspace-store.test.ts` — new tests for
  `listTaskProgressEntriesForTask` and `taskCompletionStats` (mixes of
  completed/terminal/in-progress tasks).
- `api/src/routes/v1/tasks.handlers.test.ts` — orchestration test for the
  new handler (404 path; success path delegates to
  `buildTaskRunReport`/render correctly).
- `avg-runs-to-complete.metric.test.ts` /
  `task-non-completion-rate.metric.test.ts` — unit tests per the existing
  per-metric test convention.
- `ui/`: a `TaskReportButton` component test (verifies `window.open` is
  called with the right URL) and a `task-drawer` test confirming the button
  only renders for an existing (non-new) task.
- E2E: one Playwright `@user-workflow` scenario — open a task with
  completed runs, click "Task Report", confirm the report opens. Required
  per `AGENTS.md`'s "every PR with UI behaviour ships E2E coverage" rule.
