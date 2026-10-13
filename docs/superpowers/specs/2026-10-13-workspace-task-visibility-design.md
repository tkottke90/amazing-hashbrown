# Workspace Chat Task Visibility — Design

**Date:** 2026-10-13
**Status:** Draft

---

## Goal

Workspace chat cannot answer "why did task X fail." The data exists — `TaskQueueEntry.summary` is set to a real, informative string at settlement time (e.g. `` `Run failed: ${classified.message}` ``, `task-execution.ts:627/652`), and each run's full transcript persists in its own thread — but nothing bound to `buildWorkspaceChatAgent` (`api/src/agents/chat-agent.ts:527`) can read either. `read_task_run` exists but is closed over a single `taskId` at construction time and is only ever bound inside `buildTaskAgent`, for a task reading its own prior runs. There is no `list_tasks`/`get_task` tool anywhere under `api/src/agents`; task status is REST-only, surfaced to the Kanban board, never to a chat agent.

This covers two vectors: a user explicitly asking about a task's outcome, and the agent noticing a failure on its own (from the task-run markers already mirrored into the workspace chat thread) and needing to explain it without being asked a follow-up question.

---

## Non-goals

- No new proactive scheduling/trigger mechanism. The agent already sees task-run markers mirrored into its thread; this design only makes sure it has tools to act on what it sees, and enriches that marker payload slightly. It does not add a new wake-up, digest, or notification path.
- No fuzzy/semantic task-name resolution (embeddings, scored matching). `list_tasks`'s `titleContains` is a plain substring filter — see "Why not a locate-style resolver" below.
- No dependency-graph or cohort explanation ("blocked because task Y failed, which failed because..."). `get_task_outcome` surfaces this task's own `blockedReason` verbatim; chasing a dependency chain is a possible future enhancement, not in scope here.
- No change to `workspace-summarizer.ts`'s exclusion of `task_run_marker` rows from the rolled-up "prior work summary." See the marker enrichment section below for why.
- No new UI surface — tool-call output flows through the chat rendering pipeline that already exists.

---

## Design

### 1. Scoping and binding

All three new tools are bound only inside `buildWorkspaceChatAgent` (`chat-agent.ts:541-553`), never in `buildTaskAgent` or `buildSubAgentAgent` — the same reasoning already used there to exclude `spawn_sub_agent`/`ask_user` from the sub-agent's candidate pool: a bounded delegation unit or an automated task run has no business browsing the task board, and a task run already has its own narrowly-scoped `read_task_run`.

Each tool resolves `workspaceId` at call time from `runtime.configurable?.workspaceId`, the same pattern `create-tasks.tool.ts:130` already uses, rather than capturing it at agent-construction time. A task is visible to these tools only when `task.workspaceId` exactly equals the calling workspace's id — a task with `workspaceId: null` (e.g. a webhook-created task with no workspace) or one belonging to a different workspace is never returned, and an unknown id and a cross-workspace id produce the **same** "not found" message so the tools can't be used to probe for ids outside the caller's own workspace.

This is a strictly smaller grant than what workspace chat already has: it already runs `shell_exec` inside the workspace's own directory, so read access to that same workspace's own task history adds no new trust boundary.

### 2. Why not a locate-style resolver

An earlier draft of this design had `get_task_outcome` accept a free-text `query` and resolve it server-side with tokenized title matching. That conflates two responsibilities `wiki_create_page` (`wiki-create-page.tool.ts:59`) and `wiki_locate` (`wiki-locate.tool.ts:14`) deliberately keep separate: `wiki_locate` takes free text and returns a best match, an ambiguous set, or "no match + here's what's available"; `wiki_create_page` takes only an exact, already-resolved `wikiId` — no fuzzy matching inside the action tool itself.

This design follows that precedent: `list_tasks` is the locate step (returns however many rows match a plain filter, same role as `wiki_locate`'s "browse all domains" branch), and `get_task_outcome` / the transcript tool take only an exact `taskId` already obtained from a `list_tasks` call.

### 3. Tool schemas

**`list_tasks`** — new file `api/src/agents/tools/list-tasks.tool.ts`.

```
schema: {
  status?: TaskStatus        // one of the existing TaskStatus union
  titleContains?: string     // case-insensitive substring, applied after the status filter
  limit?: number             // default 20, max 100 — same convention as read_task_run's paging
  offset?: number            // default 0
}
```

Calls `store.listTasks({ workspaceId, status })`, filters by `titleContains` in memory, paginates. For every returned row whose status is `failed` or `blocked`, batches one `store.failedRunStreaks(taskIds)` call and inlines `attempts`/`lastSummary`, so `list_tasks({status:'failed'})` alone usually answers "what failed recently" without a second call. Zero matches after filtering returns an explicit `No tasks match (status: failed, title contains "backup").` rather than an empty-looking response, so the model knows to broaden rather than assume there's no data.

**`get_task_outcome`** — new file `api/src/agents/tools/get-task-outcome.tool.ts`.

```
schema: { taskId: string }   // exact id only, resolved via list_tasks first — no free text
```

Validates `store.getTask(taskId)?.workspaceId === callingWorkspaceId`; anything else (no such task, or it belongs to another workspace) returns `No task with id "<id>" in this workspace.` On success, returns title, current status, `blockedReason` if blocked, the latest run's `summary`/`triggerSource`/timestamps, the `failedRunStreak` (attempts + lastSummary) if currently failing, and a compact list of past runs (`runId`, `runNumber`, `status`, `finishedAt`) from `listTaskRuns(taskId)` for drill-down. This is a general "what happened with X" tool, not failure-only:

| Task state | Response |
| --- | --- |
| No runs yet (`listTaskRuns` empty) | `"<title>" has not run yet (status: pending).` — no fabricated summary |
| Currently `running` | Reports the in-progress run's `startedAt`/`triggerSource` plainly; never claims a summary that doesn't exist yet |
| `done` | Latest run's summary, success-flavored |
| `failed` | Latest run's summary + `failedRunStreak` |
| `blocked` | `blockedReason` verbatim, plus latest run's summary if one exists |

**`read_workspace_task_run`** — new file `api/src/agents/tools/read-workspace-task-run.tool.ts`.

```
schema: { taskId: string, runId: string, offset?: number, limit?: number }
```

Validates task ownership exactly as `get_task_outcome` does, then validates `getTaskRun(runId)?.taskId === taskId`, then delegates to a shared `formatRunTranscript(run, offset, limit)` helper extracted from the pagination/header/footer logic currently inline in `read-task-run.tool.ts` (lines ~55-78) into a new `api/src/agents/tools/task-run-transcript.ts`. The existing task-agent `read_task_run` (`makeReadTaskRunTool`) is refactored to call the same helper — its external behavior, name, and security boundary (closed over one `taskId`/`currentRunId` at construction) do not change. Mirrors the existing tool's edge cases: a not-yet-finished run (`FINISHED` gate) and a pre-transcript run (`threadId` null, summary-only fallback) return the same messages as `read_task_run` does today.

This tool's LangChain-visible name is deliberately **distinct** from `read_task_run` (rather than reusing the same string) so that traces/logs unambiguously show which code path — and which security boundary — handled a given call, even though the two are never bound in the same agent's tool list.

### 4. Marker enrichment

`recordTaskRunMarker` (`thread-message-writer.ts:362-378`) mirrors a task's run start/end into the workspace chat thread, currently as `{taskId, taskTitle, phase, outcome, runThreadId, runNumber, triggerSource}` — no failure text, just an outcome enum. Add one field, `summary: string | null`, threaded through from the same string `task-execution.ts:627/652` already computes at settlement — additive to an existing payload, not a new mechanism.

`workspace-summarizer.ts`'s existing exclusion of `task_run_marker` rows from the rolled-up "prior work summary" is **unchanged**. The marker's new `summary` field covers "a task just failed, what happened" for as long as the marker is within the thread's live (unsummarized) window; anything older falls back to `list_tasks`/`get_task_outcome`, which read the database directly and don't depend on what the summarizer retained. Changing the summarizer's inclusion rule would bloat every future summary with every historical marker's text — a separate, riskier change nothing in this design requires.

### 5. Error handling summary

| Case | Behavior |
| --- | --- |
| Unknown `taskId`, or one belonging to another workspace | Identical message: `No task with id "<id>" in this workspace.` |
| `get_task_outcome` on a task with no runs | `"<title>" has not run yet (status: pending).` |
| `get_task_outcome` / transcript tool on a `running` task | Report in-progress state plainly; no fabricated summary |
| `read_workspace_task_run` on an unfinished run | Same "has not finished yet" message as `read_task_run` today |
| `read_workspace_task_run` on a pre-transcript run (`threadId` null) | Same summary-only fallback message as `read_task_run` today |
| `list_tasks` with zero matches | `No tasks match (status: failed, title contains "backup").` |

---

## Testing

Developer tests (Mocha + Chai), adjacent `*.test.ts` files per this repo's convention:

- `task-run-transcript.test.ts` — unit tests for the extracted pagination/header/footer helper (offset/limit math, empty-transcript message, truncation footer). This becomes the one place transcript-formatting logic is tested in depth.
- `list-tasks.tool.test.ts` — unit: status + `titleContains` filtering, workspace scoping (a task from another workspace never appears), `failedRunStreak` inlined only for `failed`/`blocked` rows, pagination, zero-match message.
- `get-task-outcome.tool.test.ts` — unit: correct detail for an own-workspace task; **identical** not-found message for an unknown id vs. a real id from another workspace (asserts no existence leak); distinct behavior across never-run / running / done / failed / blocked states.
- `read-workspace-task-run.tool.test.ts` — unit: task-ownership check precedes run-ownership check; unfinished-run rejection; pre-transcript summary-only fallback; delegates to the shared formatter (verified by spy — the formatter's own pagination output is the extracted helper's test's job, per this repo's orchestration-test guidance of verifying interactions, not re-deriving results).
- `chat-agent.test.ts` — orchestration: extend the existing inclusion/exclusion pattern (mirrors the `propose_file_merge` exclusion test at line 110) to assert all three new tools are present in `buildWorkspaceChatAgent`'s tool list and absent from `buildTaskAgent`'s and `buildSubAgentAgent`'s.
- Extend the existing `recordTaskRunMarker`/task-execution tests to assert the marker payload now carries `summary`.

No new E2E/Playwright coverage — no new UI surface is added.

### Eval requirement (EDD, non-optional)

Whether the model actually reaches for `list_tasks`/`get_task_outcome` when asked "why did task X fail" is LLM-facing behavior per root `AGENTS.md`'s Evaluation-Driven Development rules, which require a failing eval scenario before implementation. Plan: a new `tool-call`-type scenario, likely `suites/task-visibility.yaml`, seeded with a synthetic failed task/run, asserting the model calls `get_task_outcome` (directly, or via `list_tasks` first) for a "why did task X fail" prompt.

This session cannot run it — no network path to the local model providers the suites run against (rule 5). Hand-off: write the scenario, then the user runs:

```sh
npm run eval -- --suite task-visibility --model <provider> --judge-model <provider>
```

before this lands, per rule 3 (failing eval must be green before merge).
