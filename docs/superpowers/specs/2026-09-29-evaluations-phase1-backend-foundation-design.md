# Evaluations — Phase 1: Backend Foundation — Design

**Date:** 2026-09-29
**Status:** Draft
**Related:** [Evaluations Feature — Requirements Spec](https://claude.ai/code/artifact/1cf8d3b1-3a5e-4798-9bca-d8b091b40e1c) (requirements), [Evaluations feature mockups](../../Design/2026-09-29-evaluations-feature-mockups.html) (14-screen interactive UI mockup this phase was reconciled against), [Live event broadcast design](./2026-09-23-live-event-broadcast-design.md), [Cron task triggers design](./2026-09-26-cron-task-triggers-design.md) (boot-sweep / registry-resync precedent)

---

## Goal

Elevate evaluations from a CLI/SDLC-only process to a first-class, backend-tracked application feature, without regressing the existing CLI/CI workflow. This is Phase 1 of 4 — it builds only the backend foundation everything else sits on: a grouping entity for multi-suite/multi-model executions (**Evaluation Report**), a mutable run/result data model that can back a live progress UI, and priority-queue integration so evaluation traffic never has to lock the rest of the app out. **No UI work happens in this phase.**

Later phases, each its own spec: **Phase 2** — core UI (dashboard, new-run wizard, live view, report detail/diff/compare, all-reports list). **Phase 3** — skill versioning (immutable snapshots, skill-filtered eval view). **Phase 4** — CI/PR integration (`/auto-eval-pr-comment` reading off Evaluation Reports, CLI/backend trigger parity polish).

---

## Problem

- Running a real check today means the CLI, by hand, once per suite — the motivating example was 9 suites run manually for one PR, with 9 separate PR comments. Evaluation is entirely a developer/SDLC process, invisible to the rest of the application.
- `lib/evaluations/src/store.ts`'s `EvaluationsStore` (`eval_runs`, `eval_results`, `judge_calibrations`) already exists and is already written to by every `npm run eval` invocation, and the API server already boots it (`api/src/index.ts:45`) — but nothing reads it. There is no HTTP API over it, and:
  - **No grouping.** `eval_runs` has no field above `suite_id` — one row per `(suite, model, judge)` execution, no way to say "these N runs were one batch."
  - **No live progress possible.** A row is written once, via a single `INSERT`, only after the entire run finishes (`store.ts:231`). A UI showing per-suite/per-model progress as it happens has nothing to read.
  - **No version tie.** Nothing records which app version a run tested against, so there's no way to mark old runs as outdated once the app has moved on.
  - **No queue-aware execution.** The eval harness (`lib/evaluations/src/runner.ts`) calls `model.invoke()` directly — it has no relationship to `provider-queue.ts`, the mechanism that already prevents chat/automation requests from contending for a local model's capacity.

---

## Decisions (and why)

| #   | Decision | Rationale |
| --- | --- | --- |
| D1  | New **Evaluation Report** grouping entity (`eval_reports` table + nullable `report_id` on `eval_runs`). | The PR #224 pain was about treating N suite runs as one unit; a nullable FK keeps ad hoc/legacy runs (including today's CLI runs) from being forced into a report. |
| D2  | **Mutable `eval_runs` rows** with a `status` column (`queued`/`running`/`complete`/`stopped`/`interrupted`), created upfront when a report is submitted and updated in place — mirrors the existing `task_queue` table (`workspace-store.ts:547`), not a redesign. | The live-run screen needs per-suite/per-model progress as it happens; today's insert-once-at-completion model can't back that. `task_queue` already solves this exact shape of problem in this codebase. |
| D3  | **Third provider-queue lane** (`eval`, ahead of `sync`/chat, ahead of `async`/automation) instead of a UI lock. No preemption — an eval only claims the next *freed* slot. | Solves the real hardware-contention problem (documented: two concurrent local-model requests can turn 15s into 5min) at the request layer, where `provider-queue.ts` already gates chat/automation — without blocking a user from using an unaffected provider or an unrelated part of the app. |
| D4  | `ProviderQueue.acquireSlot`/`withSlot` gain an optional **`label`**, and `ProviderGate` tracks active labels alongside `activeCount`. | The design mockup shows a *reason* for a wait ("Waiting for an in-flight chat turn to finish"), which today's boolean `onWaitChange` can't produce — this is the smallest addition that makes it possible. |
| D5  | **No new SSE endpoint.** New broadcast event kinds (`eval_run_progress`, `eval_report_completed`, …) ride the existing standing app-level channel (`events.route.ts`, one connection per tab, already consumed by `ui/src/hooks/use-live-events.ts`). | The mechanism already exists for exactly this purpose; a second one would be duplicate infrastructure. |
| D6  | **CLI/backend trigger parity via a shared service function**, not HTTP. The CLI already talks to the DB directly (`bootEvaluations` is "shared by bin scripts and the API server"); report creation logic lives once and both the new `POST /reports` route and `bin/eval` call it directly. | Evaluation Report must not be a UI-exclusive concept — `/auto-eval-pr-comment` (Phase 4) runs in CI, where nothing is ever browser-triggered. |
| D7  | **TTFT dropped from this phase** (and not committed to any phase yet). Cost/tokens-per-second are ported from `stream-handler.ts`'s existing per-provider rate-table logic into the harness instead. | TTFT doesn't exist anywhere in this codebase — chat included — and would require switching the harness from `.invoke()` to `.stream()` with no existing precedent. Cost/tps logic already exists and is a much smaller port. |
| D8  | **No separate "failed" run status.** `complete` means "every scenario has a result," regardless of pass/fail/error mix; a scenario-level error is its own terminal outcome, not a run-level abort. | Keeps the run state machine small and matches how a mixed pass/fail run already reads today via `pass_rate`. |

---

## Non-goals (this phase specifically)

- Any UI screens — dashboard, new-run wizard, report views, etc. (Phase 2).
- Skill versioning / snapshot system (Phase 3).
- `/auto-eval-pr-comment` changes (Phase 4).
- Thread-based eval-case extraction (deferred in the requirements spec; this phase's schema should stay compatible with adding it later, not implement it).
- Time to First Token (TTFT).
- Multi-process / horizontal scaling of the provider queue — single process only, same as today.

---

## Design

### 1. Data model

**`eval_reports`** (new table)

| Field | Notes |
| --- | --- |
| `report_id` | Primary key |
| `trigger_source` | `ui` \| `backend` \| `cli` — any of the three can produce a Report |
| `app_version` | Pinned at creation |
| `compare_against` | Nullable FK to another `report_id`; defaults to the most recent prior report on the same scope, user-changeable |
| `created_at` / `completed_at` | `completed_at` is null while any child run is still `queued`/`running` |
| `summary` | Nullable text, agent-authored, editable |

No `status` column on `eval_reports` — a report's status is derived from its child runs (`queued` if any run is `queued`, `running` if any is `running`, `complete` once all are), not stored redundantly.

**`eval_runs`** (extends the existing table — the real change of this phase)

| Field | Notes |
| --- | --- |
| `report_id` | Nullable FK to `eval_reports` |
| `status` | `queued` \| `running` \| `complete` \| `stopped` \| `interrupted` |
| `app_version` | |
| `input_tokens` / `output_tokens` | Aggregate per run |
| `tokens_per_second` | Ported from the chat cost logic |

Row lifecycle: all `suite × model` rows for a report are created in `queued` status the moment the report is submitted, flip to `running` when the harness actually starts that pair, and reach `complete`/`stopped` at the end. `interrupted` is set by a boot-time sweep (below) for anything left `queued`/`running` from a dead process.

**`eval_results`** (extends the existing table)

Adds `input_tokens` / `output_tokens` per scenario, same reasoning as the run-level aggregate. Latency percentiles (p50/p95) need no new column — computed at read time from the existing per-result `latency_ms` values. The judge rubric breakdown (per-criterion score) is already inside the existing `details` JSON for `llm-judge`-type results — pre-existing harness behavior, not new.

### 2. Provider-queue integration & live status

**Third lane.** `ProviderGate` (`provider-queue.ts`) gets a third queue, `evalQueue`, alongside `syncQueue`/`asyncQueue`. `RequestKind` becomes `'eval' | 'sync' | 'async'`. `releaseSlot`'s drain order changes from `sync → async` to `eval → sync → async`. No preemption — an eval only claims the next freed slot; an in-flight sync/async request is never interrupted.

**Harness wiring.** Every `invoke*Model` call in `lib/evaluations/src/runner.ts` wraps through `providerQueue.withSlot(providerName, 'eval', fn, { onWaitChange, label })` instead of calling the model directly. `onWaitChange(true)` keeps/moves the `eval_runs` row to `queued`; the `withSlot` promise resolving moves it to `running`.

**Wait-reason labels.** Today's `ProviderGate` only tracks `activeCount` (a number) and anonymous queued entries — it has no way to say *what* currently holds a slot. `acquireSlot`/`withSlot` gain an optional `label` (e.g. `"chat turn"`, `"automation: nightly-regression"`, `"eval: error-recovery × qwen3:32b"`); `ProviderGate` keeps the active label(s) alongside `activeCount` so a waiter's `onWaitChange` can compose a human-readable reason for the UI.

**Server restart sweep.** On boot, anything left `queued`/`running` in `eval_runs` from a dead process is marked `interrupted` — same idea as `CronRegistry`/`WakeupRegistry` resyncing from the DB on boot rather than trusting in-memory state survived a restart.

### 3. API surface

New router `api/src/routes/v1/evaluations.route.ts` + `evaluations.handlers.ts`, mounted at `/api/v1/evaluations`.

| Route | Purpose |
| --- | --- |
| `POST /reports` | Create a report (suites, models, judge model, optional skill+version). Creates the `eval_reports` row and every `eval_runs` row in `queued` status upfront; returns `report_id` immediately, execution continues in the background |
| `GET /reports` | List, filterable by suite / model / trigger_source / app_version / skill / since |
| `GET /reports/:reportId` | Full detail: report + child runs + rollup stats. Serves both the live view and the finished report — only `status` differs |
| `PATCH /reports/:reportId` | Edit `summary`, change `compare_against` |
| `POST /reports/:reportId/stop` | "Stop after current" |
| `GET /runs/:runId/results` | Scenario-level list for a drill-down view |
| `GET /runs/:runId/diff?against=:otherRunId` | Single `(suite, model)` pair diff between two runs |

No new SSE endpoint (D5) — new broadcast event kinds ride the existing standing channel. Report-to-report compare needs no dedicated endpoint either — it's two `GET /reports/:id` calls diffed client-side; the data's already there.

**CLI/backend trigger parity (D6):** report-creation logic lives once, in the service/store layer; `POST /reports`, `bin/eval`, and any backend-scheduled trigger all call that same function directly rather than the CLI making HTTP calls to its own server.

### 4. Error handling & testing

**Error handling**

- A scenario erroring (provider timeout, malformed response, rate limit) is recorded as its own terminal outcome on that `eval_results` row; the run moves on to the next scenario rather than aborting the `(suite, model)` pair.
- `eval_runs.status` reaching `complete` means every scenario has a result, not that everything passed (D8) — pass/fail/error mix is already expressed via `pass_rate` and the per-scenario rows.
- "Stop after current" sets a cooperative cancellation flag checked *between* scenarios (the in-flight scenario finishes normally). Any other `eval_runs` row for that report still `queued` — including ones waiting on the provider queue — aborts immediately via the `AbortSignal` `acquireSlot` already supports, moving straight to `stopped` without executing.
- Server restart mid-run is handled by the boot sweep (Section 2), not repeated here.
- A judge model erroring while scoring a scenario marks that scenario's result as unscored/error rather than crashing the run.

**Testing** (per the repo's unit / orchestration / external-orchestration convention)

- **Unit** — `provider-queue.test.ts` extended for the `eval` lane's drain-order priority and label tracking; a new pure state-transition function for run status, tested exhaustively per transition the way `board-rules.ts` is.
- **Orchestration** — `POST /reports` creates the right rows and kicks off execution (supertest, spying on the harness call rather than re-testing the harness itself); broadcast events fire in the right order as a run progresses.
- **External-orchestration** — the harness's ported cost/tokens-per-second logic against mocked model responses, covering the "no rate configured → $0" default and a configured-rate case.
- **Boot sweep** — unit test for `interrupted` marking on startup, same shape as the existing cron/wakeup registry resync tests.
