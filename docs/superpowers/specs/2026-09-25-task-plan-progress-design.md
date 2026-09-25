# Task Plan Progress — Agent Visibility Into and Control Over Its Plan Checklist

**Date:** 2026-09-25
**Status:** Draft
**Related:** Issue #203

---

## Problem

A task's `plan` (`PlanStep[]`, each `{ step, done }`) is shown to the user as a checklist in the
Task Drawer, but the automated task-execution agent never sees it and cannot update it:

- `buildTaskContextBlock()` (`api/src/agents/chat-agent.ts`) includes only title, description and
  outcome — no plan.
- The only task-specific tool, `complete_task`, takes `{ outcome, summary }` and ends the run. No
  tool touches plan steps.

A traced run completed all the work in its single plan step, called `complete_task` with
`outcome: "done"`, and left the stored plan at `[{ step: "...", done: false }]`.

Two further problems surfaced while designing the fix:

1. **The Task Drawer clobbers the plan.** `task-drawer.tsx` seeds `planSteps` from `task.plan` once
   on mount and always sends the full `plan` array on Save. A user who opens the drawer during a
   run and saves any field overwrites every step the agent has checked since.
2. **Completion is detected before `complete_task` runs.** `task-execution.ts`'s
   `tapCompleteTask()` records completion from the tool's `on_tool_start` stream event, which fires
   before the tool body executes. The tool's return value cannot influence whether the run counts
   as complete, so any tool-side validation is impossible under the current wiring.

## Goals

- The task agent's system prompt includes the plan and each step's done state.
- The agent can mark plan steps done/undone; changes persist to the task's stored plan.
- `complete_task(done)` with unchecked steps nudges the agent once before accepting.
- An open Task Drawer shows plan progress live and never silently overwrites agent progress.

## Non-Goals

- The agent adding, rewording, reordering or removing plan steps. Step text and count stay
  human-owned so the checklist remains an honest record of the agreed plan versus what was done.
- A separate `get_plan` tool. The plan is in the system prompt and every `update_plan` call returns
  the full current checklist; a read tool would duplicate both.
- Sub-agent runs (`buildSubAgentAgent`). `spawn_sub_agent` never sets a plan.
- `sub-agent-notification.ts`'s parent-task turn, which calls `buildTaskAgent(parentTask)` and
  already ignores `complete_task` today. That pre-existing gap is left as-is.
- Conflict handling for any Task Drawer field other than `plan`.

---

## Design

### 1. System prompt

`TaskContext` gains `plan?: PlanStep[] | null`. `buildTaskAgent` passes `task.plan`;
`buildSubAgentAgent` passes nothing.

When the plan is non-empty, `buildTaskContextBlock()` appends a numbered checklist (1-based, the
numbering `update_plan` uses):

```
Plan (check steps off with update_plan as you finish them):
1. [x] Scaffold the route
2. [ ] Add tests
3. [ ] Update docs
```

and the closing instruction reads: "Call update_plan to mark each plan step done as you complete
it. When the outcome has been met, or you cannot proceed further, call complete_task…". With a null
or empty plan, the block is byte-for-byte unchanged from today.

The checklist rendering is a small exported helper (`formatPlanChecklist(plan)`) shared by the
prompt block, `update_plan`'s return value and `complete_task`'s rejection message, so all three
show the agent the same format.

`TaskContext`, `buildTaskContextBlock()` and `formatPlanChecklist()` move out of `chat-agent.ts`
into a new side-effect-free module, `api/src/agents/task-context.ts` (re-exported from
`chat-agent.ts` for existing importers). `chat-agent.ts` constructs the ToolsManager and loads MCP
config at import time; `bin/eval.ts` needs the real prompt builder without those side effects.

### 2. `update_plan` tool

New file `api/src/agents/tools/update-plan.tool.ts`:

```ts
export function makeUpdatePlanTool(taskId: string, store?: WorkspaceStore);
```

Closed over the task id (like `makeCompleteTaskTool`), with an optionally injected store defaulting
to `getWorkspaceStore()` (like `makeCreateTasksTool`).

- **Schema:** `{ updates: Array<{ step: number (int, ≥ 1), done: boolean }> }` (at least one entry).
  `step` is the 1-based number shown in the prompt.
- **Behavior:** re-read the task from the store (never a copy cached at run start), apply all
  updates to a copy of the plan, write once via `store.patchTask(taskId, { plan })`, then
  `broadcast({ type: 'task_plan_updated', taskId, plan })`.
- **Returns:** `formatPlanChecklist(updatedPlan)` prefixed with a one-line confirmation.
- **Validation (never throws; returns a string the model can act on):**
  - Any `step` out of range: reject the whole call, write nothing, return the valid range and the
    current checklist.
  - Task has no plan / empty plan: "This task has no plan steps to update."
  - Task not found: an error string.
- **Binding:** added only in `buildTaskAgent`'s tool list.
- **Catalog:** new `TOOL_CATALOG` entry, `category: 'built-in'`, `alwaysOn: true` alongside
  `complete_task`, so per-thread tool settings cannot strip it from a task run.

### 3. `complete_task` nudge-once

`makeCompleteTaskTool(taskId, opts?)` where

```ts
interface CompleteTaskOptions {
  getPlan?: () => PlanStep[] | null;
  onAccepted?: (call: { outcome: 'done' | 'failed'; summary: string }) => void;
}
```

Per tool instance (i.e. per agent build), a closure flag `nudged = false`:

| Call                                                   | Result                                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outcome: "failed"`                                    | Accepted.                                                                                                                                                                                                                                                           |
| `outcome: "done"`, no `getPlan` or no unchecked steps  | Accepted.                                                                                                                                                                                                                                                           |
| `outcome: "done"`, unchecked steps, `nudged === false` | Rejected. Sets `nudged = true`. Returns: "Not completed: steps 2, 3 are still unchecked. Mark them done with update_plan if you finished them, or call complete_task again if they were intentionally skipped." plus the checklist. `onAccepted` is **not** called. |
| `outcome: "done"`, unchecked steps, `nudged === true`  | Accepted.                                                                                                                                                                                                                                                           |

On acceptance the tool calls `onAccepted?.({ outcome, summary })` and returns the existing
`Task ${taskId} marked ${outcome}: ${summary}` message.

`getPlan` reads the store at call time, so steps checked earlier in the same run count.

**Known limitation:** the nudge flag lives in the tool closure. A HITL resume rebuilds the agent, so
one task can be nudged once per run segment. Harmless.

With no options (sub-agents, `sub-agent-notification.ts`) behavior is identical to today.

### 4. Execution wiring

`buildTaskAgent` gains an optional final parameter:

```ts
hooks?: { onTaskComplete?: (call: CompleteTaskCall) => void }
```

and builds:

```ts
makeCompleteTaskTool(task.id, {
  getPlan: () => getWorkspaceStore().getTask(task.id)?.plan ?? null,
  onAccepted: hooks?.onTaskComplete,
}),
makeUpdatePlanTool(task.id),
```

`task-execution.ts`:

- Deletes `tapCompleteTask()` and `parseCompleteTaskInput()` (and their comment block on
  LangChain's `on_tool_start` input wrapping — no longer relied upon; the tool receives validated
  arguments directly).
- Keeps `completeTaskBox`, now populated by the `onTaskComplete` hook passed into
  `buildAgent(..., { onTaskComplete: (c) => { completeTaskBox.current = c; } })`. Last accepted
  call wins, matching today's overwrite semantics.
- Passes the raw `streamEvents` stream straight to `pipeEvents`.
- Everything after `finalizeTurn` (`completeQueueEntry`, sub-agent delivery, interrupted / failed
  branches) is unchanged.

Behavioral consequence: a rejected `complete_task(done)` is not a completion. If the agent is
nudged and then stops without calling `complete_task` again, the run falls into the existing
"stopped without complete_task" branch and ends `failed`. That is correct — the agent never
confirmed completion.

`ExecuteTaskDeps.buildTaskAgent` keeps the type `typeof buildTaskAgent`, so test fakes receive the
hooks and can invoke `onTaskComplete` to simulate completion.

### 5. Broadcast event

`lib/llm-common-types/src/chat/broadcast-events.ts`:

```ts
export const TaskPlanUpdatedEventSchema = z.object({
  type: z.literal('task_plan_updated'),
  taskId: z.string(),
  plan: z.array(z.object({ step: z.string(), done: z.boolean() })),
});
```

added to the `AppBroadcastEventSchema` discriminated union. Emitted only by `update_plan`. The human
`PATCH /tasks/:id` path does not emit it — the only viewer of that change is the drawer that made
it.

**Concurrency:** SQLite writes are synchronous and `update_plan`'s read-modify-write happens within
one tick, so it cannot interleave with another in-process write. The remaining race is
human-vs-agent, handled in the UI (§6).

### 6. UI

**`ui/src/hooks/use-live-events.ts`** — new case:

```ts
case 'task_plan_updated':
  tasks.value = tasks.value.map((t) =>
    t.id === event.taskId ? { ...t, plan: event.plan } : t,
  );
  return;
```

Local patch, no refetch — same pattern as `patchTaskStatus`.

**`ui/src/components/task-drawer.tsx`:**

Existing behavior to preserve: toggling a checkbox (`toggleStep`) and appending AI-generated steps
(`handleGeneratePlan`) already persist immediately via `updatePlan()` (`ui/src/hooks/use-tasks.ts`)
for an existing task. Only adding a step, editing step text and deleting a step wait for Save.

- **`planDirty` signal**, `false` on open, set `true` only by the deferred mutations: add, edit
  text, delete. Toggle and generate are already persisted, so they don't mark the plan dirty.
- **No clobber:** when patching an existing task, Save includes `plan` only if `planDirty` is true.
  Creating a new task always includes `plan` (unchanged).
- **Live sync:** an effect reads this task's entry from `tasks.value`. When its `plan` differs from
  the last-applied server plan:
  - `planDirty === false` → replace `planSteps.value` with the incoming plan.
  - `planDirty === true` → keep local edits; show a one-line notice above the plan: "The agent
    updated this plan while you were editing. Saving will overwrite its progress."

No merge logic. The notice turns an overwrite into an informed choice rather than a silent one.

---

## Testing

### Evals (written first, per EDD)

**Harness addition.** `bin/eval.ts` can only call `buildSystemPrompt(userInstructions)`; no suite
can simulate a task run's context block. Add a suite-level optional field to
`lib/evaluations/src/schemas.ts`:

```ts
simulatedTask: z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  outcome: z.string().optional(),
  plan: z.array(z.object({ step: z.string(), done: z.boolean() })).optional(),
}).optional();
```

When set, `bin/eval.ts` passes `buildTaskContextBlock(simulatedTask)` as `buildSystemPrompt`'s
context block — exercising the real prompt text rather than a hand-copied string. Every existing
suite omits it and is unaffected.

`evalTools` gains `makeUpdatePlanTool('eval-task')` and `makeCompleteTaskTool('eval-task')`.
Tool-call scenarios assert on which tool the model calls and never execute it, so the placeholder id
is harmless.

**New suite `suites/task-plan-progress.yaml`** — one 3-step simulated task, `passingThreshold: 1.0`,
confirmed failing before implementation:

| id                                    | Type          | Seeded history                                                                   | Expectation                                                  |
| ------------------------------------- | ------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `bug-203-marks-step-after-work`       | tool-sequence | `shell_exec` output showing step 1's work finished                               | `update_plan`; `updates.0.step` = 1, `updates.0.done` = true |
| `bug-203-completes-after-all-checked` | tool-sequence | `update_plan` result showing all 3 steps `[x]`                                   | `complete_task`; `outcome` = `done`                          |
| `bug-203-heeds-nudge`                 | tool-sequence | work for all steps finished, then a `complete_task` rejection listing steps 2, 3 | `update_plan`                                                |
| `bug-203-no-premature-complete`       | tool-sequence | step 1 done; steps 2–3 still pending                                             | `!complete_task`                                             |

Each scenario carries a `purpose` explaining why the behavior matters.

### Developer tests (Mocha, API / lib)

- `update-plan.tool.test.ts` `[unit]`: applies and persists toggles; multiple updates in one write;
  out-of-range step rejects the whole call with no write; empty plan; missing task; return value is
  the rendered checklist; broadcast emitted with the new plan (and not emitted on rejection).
- `complete-task.tool.test.ts` `[unit]`: `failed` always accepted; `done` with all steps checked
  accepted; `done` with unchecked steps rejected once (lists those steps, `onAccepted` not called)
  then accepted on the second call; no `getPlan` → today's behavior.
- `task-context.test.ts` `[unit]` (`buildTaskContextBlock`, moved from `chat-agent.test.ts`): plan rendered with `[x]/[ ]` and 1-based
  numbers; no plan section for null/empty; sub-agent variant unchanged.
- `task-execution.test.ts` `[orchestration]`: existing completion tests reworked to drive completion
  via the `onTaskComplete` hook instead of fake `on_tool_start` events; a nudged-then-stopped run
  ends `failed`.
- `broadcast-events` schema: `task_plan_updated` parses; malformed plan rejected.

### UI (Jest)

- `use-live-events`: `task_plan_updated` patches `plan` on the matching task only.
- `task-drawer`: Save omits `plan` when untouched, includes it after an edit; incoming plan replaces
  displayed steps when not dirty; conflict notice shown when dirty.

### E2E (Playwright, CI-safe, no LLM)

- `e2e/tests/task-plan-field.spec.ts` — no clobber: open drawer on a task with a plan, check a step
  via the API behind the drawer, edit only the title, Save, verify the API-side check survived.
- `e2e/tests/live-task-events.spec.ts` — a mocked `task_plan_updated` SSE frame on
  `/api/v1/events` checks the corresponding box in an open drawer and advances the progress bar.

---

## Files touched

| File                                                   | Change                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `api/src/agents/task-context.ts` (new)                 | `TaskContext.plan`, `buildTaskContextBlock`, `formatPlanChecklist` |
| `api/src/agents/chat-agent.ts`                         | re-exports, `buildTaskAgent` hooks + new tools                     |
| `api/src/agents/tools/update-plan.tool.ts` (new)       | `update_plan` tool                                                 |
| `api/src/agents/tools/complete-task.tool.ts`           | options, nudge-once, `onAccepted`                                  |
| `api/src/agents/task-execution.ts`                     | remove stream tap, use hook                                        |
| `api/src/agents/tool-catalog.ts`                       | `update_plan` entry                                                |
| `lib/llm-common-types/src/chat/broadcast-events.ts`    | `task_plan_updated` event                                          |
| `lib/evaluations/src/schemas.ts`, `bin/eval.ts`        | `simulatedTask`, eval tools                                        |
| `suites/task-plan-progress.yaml` (new)                 | eval suite                                                         |
| `ui/src/hooks/use-live-events.ts`                      | handle `task_plan_updated`                                         |
| `ui/src/components/task-drawer.tsx`                    | `planDirty`, conditional plan save, live sync, notice              |
| `ui/test/__mocks__/llm-common-types/chat.ts`           | mirror `task_plan_updated` in the Jest mock of the shared schema   |
| tests adjacent to each of the above; the two E2E specs |                                                                    |
