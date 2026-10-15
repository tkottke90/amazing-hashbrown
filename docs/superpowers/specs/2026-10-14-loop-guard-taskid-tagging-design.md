# Loop-Guard Reflection Traces: Tag with taskId

## Issue

[#303](https://github.com/tkottke90/amazing-hashbrown/issues/303) — Every
`source: 'loop-guard'` observability trace is recorded with `taskId: null`,
even for task runs, so `GET /api/v1/traces?taskId=<id>` misses them.

## Root cause

`recursion-guard.middleware.ts`'s `beforeModel` hook reads
`runtime?.configurable?.taskId` when a stagnation/streak reflection fires
(`evaluateLoopProgress`). `task-execution.ts` builds `config.configurable` as
`{ thread_id, workspaceId? }` — `taskId` is never included — so that read is
unconditionally `undefined` for every task run.

`recursion-guard.middleware.ts` is the only place in `api/src` that reads
`configurable.taskId`; this is a narrow, contained fix.

## Fix

Closure-bind `taskId` into `createRecursionGuardMiddleware`'s options at
construction time, the same pattern `makeUpdatePlanTool(task.id)` and
`create-tasks.tool.ts`'s `callingTaskId` already use, instead of threading it
through the generic `runtime.configurable` bag.

### Changes

1. **`api/src/agents/recursion-guard.middleware.ts`**
   - Add `taskId?: string` to `RecursionGuardOptions`.
   - Destructure it in `createRecursionGuardMiddleware` alongside the
     existing options.
   - In the `evaluateLoopProgressImpl(...)` call inside `beforeModel`,
     replace `taskId: runtime?.configurable?.taskId` with the closure-bound
     `taskId`.

2. **`api/src/agents/chat-agent.ts`**
   - In `buildTaskAgent` (the only `createRecursionGuardMiddleware`
     construction site with a real task in scope), add `taskId: task.id` to
     the options object passed in.
   - No other call site changes: `buildChatAgent`, the workspace-chat
     builder, and `buildSubAgentAgent` have no task to tag and correctly
     keep `taskId` unset (loop-guard traces for those stay `taskId: null`,
     which is accurate — there is no task).

3. **`api/src/agents/task-execution.ts`** — untouched. `config.configurable`
   stays `{ thread_id, workspaceId? }`; `taskId` no longer needs to travel
   through it at all.

### Why this over adding `taskId` to `config.configurable`

`task.id` is already closure-available at the exact site
`createRecursionGuardMiddleware` is constructed, matching the codebase's
existing closure-binding convention for task-scoped values. It avoids
growing `configurable` into a generic bag of task-scoped fields threaded
through `runtime` — the kind of escape-hatch shape the root `AGENTS.md`'s
composition-over-customization principle calls out as a smell. It's also the
smaller diff: one options object and one field read change, with
`task-execution.ts`'s config-building logic and type annotation left alone.

## Data flow

```
buildTaskAgent(task, ...)
  -> createRecursionGuardMiddleware({ ..., taskId: task.id })
       -> beforeModel(state, runtime)
            -> evaluateLoopProgressImpl({ ..., taskId })   // closure-bound, not runtime.configurable
                 -> startTrace({ source: 'loop-guard', taskId, ... })
```

## Testing

Unit-level only — this is a pure wiring change with no new I/O boundary.

- `recursion-guard.middleware.test.ts`: extend the existing
  `evaluateLoopProgress`-stub assertions (the suite already asserts on call
  args for stagnation/streak reflection) to cover:
  - `taskId` is passed through to `evaluateLoopProgress` when the option is
    set and a reflection fires.
  - `taskId` is `undefined` when the option is omitted (covers
    `buildChatAgent`/workspace-chat/`buildSubAgentAgent`'s unchanged
    behavior).

No orchestration or external-orchestration test is needed: nothing here
crosses a real I/O boundary, and `task-execution.ts` is unchanged.

## Out of scope

- `buildSubAgentAgent`'s loop-guard traces: it has no task in scope the same
  way `buildTaskAgent` does today, and per the issue this is a narrow fix —
  not a broader pattern to chase.
- Any change to how `loop-reflection.ts` builds or persists the trace itself
  — it already accepts and forwards `taskId` correctly; only the value it
  receives was wrong.
