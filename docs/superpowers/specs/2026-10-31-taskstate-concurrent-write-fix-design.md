# Fix: `taskState` concurrent-write collision (issue #362)

## Context

Issue #362 reports `Run failed: Invalid update for channel "taskState" with values [...]` hitting multiple unrelated scheduled tasks, and diagnoses it as scheduled-task fires colliding on a shared state write. That diagnosis is wrong in one important way: each scheduled run gets its own `thread_id` and its own fresh graph (`task-execution.ts`) — there is no shared state object across runs. The real collision is _within a single run_: `write_task_note` and `update_plan` (`api/src/agents/tools/write-task-note.tool.ts`, `update-plan.tool.ts`) can both write the `taskState` graph channel in the same superstep if the model emits both tool calls in one turn, and the channel had no reducer. Five "unrelated" tasks failing in the same window is five independent runs hitting the same latent per-run bug, not one task colliding with another.

See `GLOSSARY.md` § Task Files for the vocabulary (Task File, Task State, Task Notes) — this spec doesn't redefine them, and the fix here doesn't change what any of them mean at the domain level. See ADR-0047 for the architectural decision this design implements (and ADR-0037, which ADR-0047 partially supersedes) — this spec implements that decision rather than re-arguing it.

This was reached through a full grilling (design-interview) pass with the repo owner; every section below reflects an explicit answer, not an assumption.

## Existing system (facts gathered during research)

- `taskState` is a plain Zod field on `taskFileStateSchema` (`api/src/agents/task-file-state.middleware.ts:21-23`), built via `createMiddleware({ name, stateSchema })` from the `langchain` package. A bare Zod field with no reducer metadata always becomes a `LastValue` channel in `@langchain/langgraph`'s schema-to-channel conversion, which throws `InvalidUpdateError` ("LastValue can only receive one value per step") when it receives more than one write in a step.
- Scheduling is cron-based (`cron-registry.ts`), firing only through `WorkspaceStore.fireCronTask()`. Every run mints its own `thread_id` on first start (`task-execution.ts:250-275`) and builds a fresh agent/graph via `buildAgent()` — no shared/global graph instance across runs, no cross-run collision path.
- `write_task_note` and `update_plan` are the only two tools that write `taskState`, and both follow the same pattern: read `runtime.state.taskState` as `current`, compute a full `nextState = { ...current, notes: nextNotes }`, call `writeTaskFile(filePath, nextState, meta)` directly (ADR-0037's inline-write precedent), then `return new Command({ update: { taskState: nextState, messages: [...] } })`. Neither tool touches `goal`, `previousTasks`, `outcome`, or `handoff` — both only ever append to `notes[notes.length - 1]`.
- `goal`, `previousTasks`, `outcome`, and `handoff` are written only by `task-execution.ts`'s orchestrator, sequentially, outside the tool-call loop (pre-Run and post-Run) — never part of this race, untouched by this fix.
- `@langchain/langgraph@1.4.21`'s `BinaryOperatorAggregate.update(values)` (`dist/channels/binop.cjs`) folds sequentially against the real persisted channel value, one new write at a time: `current = reducer(current, writeA); current = reducer(current, writeB)`. The reducer never sees two isolated "new" values in isolation — it always sees the authoritative running state plus one new write. `withLangGraph(zodSchema, { reducer: { fn, inputSchema }, default })` (exported from `@langchain/langgraph`) is the public mechanism for attaching a reducer to a Zod-schema-based middleware field; `messages`/`addMessages` resolves through this exact same `ReducedValue` → `BinaryOperatorAggregate` path, just via a pre-built instance rather than `withLangGraph` metadata.
- No `createMiddleware` lifecycle hook sees post-reduction state within the same step. `afterModel` fires before the tools node runs at all. `wrapToolCall` wraps one call at a time, with `request.state` reflecting the pre-reduction value. `beforeModel` fires after the _prior_ step's tool-node reduction has committed — it sees last step's merged state, but a `return_direct` tool routes straight to `END` and never reaches another `beforeModel`. `afterAgent` fires once, after the whole invocation (model calls and tool executions) completes, which does cover that final-step case.
- Checkpoints (`SqliteSaver`, used by `chat-agent.ts` — persistent, survives restarts) only serialize each channel's raw value, never its class or reducer (`Checkpoint.channel_values: Record<string, unknown>`; `fromCheckpoint()` always builds a fresh channel instance from the current code's schema). Changing `taskState` from a `LastValue` to a `BinaryOperatorAggregate` is safe to deploy against existing in-flight checkpoints.

## Design

### 1. `taskState` channel gets a reducer, tools send deltas

`api/src/agents/task-file-state.middleware.ts` wraps `taskState` in `withLangGraph(TaskStateSchema.default(cloneEmptyTaskState), { reducer: { fn: mergeTaskState, schema: TaskStateAppendSchema }, default: cloneEmptyTaskState })`, turning the channel into a `BinaryOperatorAggregate`.

`TaskStateAppendSchema` (new, same file) is the write-side shape both tools send instead of a full `TaskState` snapshot:

```ts
const TaskStateAppendSchema = z.object({
  appendNotes: z.array(z.string()),
});
```

`mergeTaskState(current: TaskState, delta: { appendNotes: string[] }): TaskState` appends `delta.appendNotes` onto the last entry of `current.notes` and returns a new object (new array references for `notes` and its last segment — this is what makes the reference-equality dirty check in §2 correct). No diffing or prefix-matching against a stale base is needed, because the reducer always folds against the real accumulated value (per the `BinaryOperatorAggregate.update` semantics above), not against two independent candidates. Two or more concurrent appends in the same step are folded in whatever order LangGraph processes that step's writes — unspecified order, but no entry from either write is ever lost.

`write_task_note` and `update_plan` both change their `Command` to `update: { taskState: { appendNotes: [...] }, messages: [...] }` and drop their own `nextState` computation for the `taskState` field entirely (both still keep their other existing side effects — `update_plan`'s `store.patchTask`/`broadcast()` are a separate concern, untouched).

**Correction found during implementation:** `task-execution.ts` also writes `taskState` — as a _full_ `TaskState` object, passed as part of the top-level `agent.invoke()` input at the start of a fresh run (`{ messages: [...], taskState: taskFileScope.state }`). That seed goes through the exact same channel-update path as a tool's Command (LangGraph's `mapInput` turns top-level invoke input into the same kind of channel write a node's `Command` produces), so `mergeTaskState`'s delta parameter must accept either shape: `TaskStateUpdateSchema = z.union([TaskStateSchema, TaskStateAppendSchema])`, with the reducer treating a value that lacks `appendNotes` as a full replace. This is always safe — the seed happens once, before any node (including a tool) has run, so it can never be concurrent with an append.

### 2. Task File disk write moves to `beforeModel` + `afterAgent`

Both tools currently call `writeTaskFile()` directly from their own body (ADR-0037), computed from the same stale pre-step `current` — an independent lost-update race on the Task File itself, which §1's reducer does nothing to fix (it fixes the graph channel, not the file). Per ADR-0047, both tools stop calling `writeTaskFile()` at all. `task-file-state.middleware.ts` instead registers `beforeModel` and `afterAgent` hooks (the only two that together cover every step boundary — see Existing System note above) that each do:

```ts
if (state.taskState !== lastPersisted) {
  await writeTaskFile(filePath, state.taskState, meta);
  lastPersisted = state.taskState;
}
```

`lastPersisted` is a closure variable, built fresh per task run (same per-construction-factory pattern `makeWriteTaskNoteTool`/`makeUpdatePlanTool` already use) — initialized to the channel's default value so the very first write still triggers a persist. The reference-equality check is correct because `mergeTaskState` always returns a new object when it runs, and the channel object reference is only replaced when something actually wrote to it that step (an unrelated tool call in that step leaves `state.taskState` pointing at the same object `lastPersisted` already holds).

`writeTaskFile`'s existing failure handling (log and continue — "I/O failure must never fail the tool call") carries over unchanged to these hooks; filePath and meta (`taskId`, `title`) are the same values the tools already closed over, now closed over by the hooks instead.

`task-execution.ts`'s own pre-Run/post-Run `writeTaskFile` calls are unaffected (ADR-0047).

### 3. Testing

No eval scenario — this is a platform/graph-state defect reproducible deterministically with a stubbed model, not a question of LLM output quality.

- **Unit**: `mergeTaskState` in isolation — single append, multiple concurrent appends folded in sequence, empty `appendNotes`, and that `goal`/`previousTasks`/`outcome`/`handoff` pass through untouched.
- **Orchestration**: drive the compiled task agent with a stubbed model that returns both `write_task_note` and `update_plan` tool calls in one `AIMessage`, asserting the run completes without `InvalidUpdateError`, the final `taskState.notes` contains both tools' entries, and `writeTaskFile` was called exactly once for that step with the merged state (spy on the shared `writeTaskFile` utility, per AGENTS.md's orchestration-test convention of spying over mocking).
