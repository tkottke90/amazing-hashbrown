# Task & Loop-Guard Telemetry — Design

Date: 2026-11-28
Status: Implemented (views revised to named query fragments — see § 5)

Extends the Telemetry Endpoint from [2026-11-27-telemetry-endpoint-design.md](2026-11-27-telemetry-endpoint-design.md) (#452). Terms are defined in `GLOSSARY.md` (§ Telemetry, § Loop Guard, § Task Runs); this document does not restate them.

## 1. Problem

The Telemetry Endpoint exposes token, cost and tool-call totals only. It says nothing about how the Loop Guard behaves or how Task Runs perform. We want five new signals:

1. How often a Loop-Guard Escalation fires, and which Escalation Answer the user gives.
2. After each Escalation Answer, how often the Run ends `done` vs `blocked` (Escalation Outcome).
3. Average Runs per completed Task.
4. Average Run duration per provider/model.
5. Average plan steps per completed Task.

## 2. Settled decisions

| Question         | Decision                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HITL scope       | Only Loop-Guard Escalations (`loop_stagnation_warning`, `recursion_limit_warning`); `ask_user` and shell-approval prompts are excluded. Task and chat threads both count. |
| Answer bucketing | `continue`, `stop_and_summarize`, `custom`; an unanswered prompt is `pending`.                                                                                            |
| Outcome          | Run-level, not Task-level: `done` → `done`, `handed_off` → `blocked`, anything else → `other`.                                                                            |
| Runs per task    | All Runs (including failed and cancelled) of Tasks currently `done`, excluding Sub-Agent Tasks.                                                                           |
| Duration         | Wall-clock `finished_at − started_at`. Includes time waiting on a human during a HITL pause; accepted and stated in the metric help text.                                 |
| Plan steps       | Current `tasks.plan` length of `done` Tasks; null/empty plans skipped. No migration. This is the final plan, not the original.                                            |
| Averages         | Exposed as a sum/count pair, not a histogram. The average is a PromQL ratio.                                                                                              |
| SQL joins        | Named SQL fragments (not persisted views) only where there is a join (#2, #4). #1, #3, #5 are plain queries.                                                              |

## 3. Metric type: gauges, not counters (supersedes the counter assumption in ADR-0077)

ADR-0077 derives Prometheus _counters_ from stored rows and relies on those rows never being deleted. That does not hold for this data:

- `deleteTask()` removes the Task's `task_queue` rows and the Task itself (`workspace-store.ts`).
- `deleteThread()` removes a thread's `thread_messages`.
- A Task leaves the "done" set when it is reopened or rerun, so #3 and #5 shrink.

A counter derived from this data would decrease, and Prometheus would read each decrease as a process restart. Every metric here is therefore exposed as a **gauge of the currently-stored population**, named without `_total`. Consequences:

- `rate()` and `increase()` are not meaningful on these. Read them as "current total" and graph over time.
- Averages are plain ratios of two gauges, e.g. `hashbrown_done_task_runs / hashbrown_done_tasks`.
- A deletion lowers a gauge honestly instead of producing a phantom reset.

Recorded as ADR-0078.

## 4. Metrics

All collectors follow the #452 pattern: one `register*Collector` call in `api/src/services/telemetry/registry.ts`, a synchronous `collect()` that `reset()`s and re-applies stored values, store access through getters.

| Metric                                     | Type  | Labels                      | Source                                                        |
| ------------------------------------------ | ----- | --------------------------- | ------------------------------------------------------------- |
| `hashbrown_loop_guard_escalations`         | gauge | `kind`, `context`, `answer` | query over `thread_messages` (§ 4.1)                          |
| `hashbrown_loop_guard_escalation_outcomes` | gauge | `answer`, `outcome`         | `ESCALATION_OUTCOMES_SQL` fragment (§ 4.2)                    |
| `hashbrown_done_tasks`                     | gauge | —                           | `WorkspaceStore` query (§ 4.3)                                |
| `hashbrown_done_task_runs`                 | gauge | —                           | `WorkspaceStore` query (§ 4.3); sum of Runs across done Tasks |
| `hashbrown_task_runs_finished`             | gauge | `provider`, `model`         | `TASK_RUN_DURATIONS_SQL` fragment (§ 4.4); count              |
| `hashbrown_task_run_seconds`               | gauge | `provider`, `model`         | `TASK_RUN_DURATIONS_SQL` fragment (§ 4.4); sum of seconds     |
| `hashbrown_done_tasks_with_plan`           | gauge | —                           | `WorkspaceStore` query (§ 4.5); count                         |
| `hashbrown_done_task_plan_steps`           | gauge | —                           | `WorkspaceStore` query (§ 4.5); sum                           |

Example PromQL: average Runs per done Task is `hashbrown_done_task_runs / hashbrown_done_tasks`; average Run seconds per model is `hashbrown_task_run_seconds / hashbrown_task_runs_finished`.

### 4.1 Escalation counts (#1) — plain query

Counts `hitl_prompt` messages whose `payload.kind` is a Loop-Guard escalation kind, grouped by:

- `kind`: `payload.kind`.
- `context`: the owning thread's `threads.type` (`task`, `chat`, `workspace-chat`, …).
- `answer`: `pending` when `status = 'pending'`, else `continue` when the answer is `Continue working`, `stop_and_summarize` when it is `Stop and summarize what you have done so far`, else `custom`.

**Mirror copies must be excluded.** A Task Run's prompt is copied into the Workspace chat thread (`mirrorPendingTaskPrompts`, `thread-message-writer.ts`). The copy carries `payload.sourcePromptId`; rows with that field are skipped, or every workspace Task escalation counts twice and shows up under the wrong `context`.

The two choice strings are defined in `recursion-guard.middleware.ts`. The query must use shared constants, not re-typed literals, so a reworded choice cannot silently turn every answer into `custom`.

`thread_messages` has no index on `kind`; the query scans the table each scrape. Acceptable at this app's size; if not, add the cache from ADR-0077's consequences rather than an index.

### 4.2 Escalation outcomes (#2) — `ESCALATION_OUTCOMES_SQL`

One row per **answered** original (non-mirror) escalation prompt in a Task Run thread, joined `thread_messages.thread_id = task_queue.thread_id`:

- `answer`: same bucketing as § 4.1.
- `outcome`: `CASE task_queue.status WHEN 'done' THEN 'done' WHEN 'handed_off' THEN 'blocked' ELSE 'other' END`.

Pending prompts have no outcome and are excluded. A Run still in flight reads as `other` until it settles, so a gauge moves from `other` to `done`/`blocked` over time; that is correct, not a bug.

Outcome is the Run's, not the Task's: a Task's own status changes later when it is reopened or rerun, which would rewrite history.

### 4.3 Runs per completed Task (#3) — plain query

Over Tasks with `status = 'done'`, excluding Sub-Agent Tasks via `subAgentTaskSql()`: count of Tasks, and total `task_queue` rows for them. All Run statuses count.

### 4.4 Run duration (#4) — `TASK_RUN_DURATIONS_SQL`

One row per settled Run (`finished_at` and `started_at` both non-null), with `seconds` from `julianday()` difference, and `provider`/`model` taken from the Run's observability trace:

- Join `observability_traces` on `thread_id = task_queue.thread_id`, restricted to `source = 'task-run'`. The Loop Guard's own reflection call writes a separate `source = 'loop-guard'` trace under the same thread; without this filter its (possibly different) model would be attributed to the Run.
- A resumed Run (after a HITL answer) opens a new trace on the same thread. Use the Run's **earliest** `task-run` trace so each Run appears once.
- A Run with no trace is kept, with `provider`/`model` = `unknown`, rather than dropped.

All settled Runs count, Sub-Agent Task Runs included (they use provider time too). Duration includes HITL wait time (§ 2).

### 4.5 Plan steps (#5) — plain query

Over Tasks with `status = 'done'` and non-null, non-empty `plan`, excluding Sub-Agent Tasks: count of Tasks, and `SUM(json_array_length(plan))`. `plan` is reset at Run start (`task-execution.ts`), so this reflects the plan the final Run ended with.

## 5. Joins: named fragments, not persisted views

The two joins are exported-nowhere `const` SQL strings in `workspace-store.ts` (`ESCALATION_OUTCOMES_SQL`, `TASK_RUN_DURATIONS_SQL`), embedded as `FROM (...)` subqueries by `queryEscalationOutcomes()` and `queryTaskRunDurations()`. There is no migration and no schema change.

**This revises the originally approved "SQL views" decision.** The first implementation used `CREATE VIEW` in a WorkspaceStore migration, and it broke 23 existing tests. SQLite re-parses every view whenever any `ALTER TABLE` runs, so a persisted view that names another store's table (`thread_messages`, `observability_traces`) makes that store's migrations fail with `error in view …: no such table` whenever it boots before the table exists. Boot order across the stores is not guaranteed (production or tests), and `v_usage` only gets away with it because it reads tables its own store creates. The fragment keeps the SQL in one named, testable place and drops the ordering hazard.

- All three stores share one SQLite database and connection (`openDatabase()`, `api/src/index.ts`), so the joins are plain SQL.
- The choice strings and escalation kinds are interpolated from `loop-guard-choices.ts`, never re-typed.
- Query tests build all three stores on one database.

## 6. Testing

Per `AGENTS.md`, every new unit is tested; tests sit beside the source and carry `[unit]` / `[orchestration]` tags.

- Collectors: unit tests with a stubbed store, in the style of `llm-usage.collector.test.ts` — one test per metric for label sets and values, plus an empty-store case.
- Queries: unit tests against in-memory SQLite with seeded rows, covering at least:
  - an answered prompt per answer bucket, and a `pending` one;
  - a mirrored prompt copy is **not** double-counted;
  - Run status → outcome mapping, including an in-flight Run → `other`;
  - a Run with a `loop-guard` trace and a `task-run` trace attributes the `task-run` model;
  - a resumed Run with two `task-run` traces appears once;
  - a Run with no trace → `unknown`;
  - a Sub-Agent Task is excluded from #3 and #5;
  - a deleted Task's Runs disappear from the gauges.
- `telemetry.handlers.test.ts`: the new metric names appear in the scrape output.
- No E2E: no UI change, and the endpoint is off by default, consistent with #452.

## 7. Out of scope

- Per-Task (rather than per-Run) Escalation Outcome.
- Paused-time-adjusted Run duration.
- A column recording plan size at Run end; revisit if the final-plan approximation proves misleading.
- Histograms or percentile buckets.
- Shell-approval and `ask_user` HITL metrics.
- Pruning/retention of Runs, threads or prompts; deletion is already handled by the gauge model.

## 8. Review decisions

1. **Gauges for everything** (§ 3) — confirmed. Earlier in the discussion #1, #2 and #4 were slated to be counters and only #3 and #5 gauges; Task and thread deletion makes that unsafe for all five.
2. **Sub-Agent Task Runs stay in #4** — confirmed. Run duration counts every settled Run, Sub-Agent Tasks included; runs-per-task (#3) and plan steps (#5) still exclude them.
3. **Open: `hitl_prompt` scan has no index** on `kind` (§ 4.1). Accepted for now; add the short cache from ADR-0077 if scrapes get slow.
