# Turn Observability Migration — Design

**Date:** 2026-09-30
**Status:** Approved
**Issue:** [#219 — Turn observability wiring is copy-pasted per handler and silently missed](https://github.com/tkottke90/amazing-hashbrown/issues/219)
**Related:** [#131](https://github.com/tkottke90/amazing-hashbrown/issues/131) (model resolution bug this closes off for good), [#132](https://github.com/tkottke90/amazing-hashbrown/issues/132) (introduced the shared helper this issue migrates everything onto)

---

## 1. Problem & Goal

`api/src/agents/turn-observability.ts` (`resolveTurnModel` + `startTurnObservability`, from #132) already exists and is used by `task-execution.ts`. Every other turn runner still hand-rolls the same block inline: resolve provider/model, `getObservabilityStore().startTrace(...)`, `new ObservabilityCallbackHandler(...)`, wire it into `streamEvents`/`invoke`, pass it to `finalizeTurn()`, and `endTrace()` in a `finally`. That block is copy-pasted 14 times across 7 files, and `headless-turn.ts` (timed wake-ups, sub-agent completion notifications) has **no** observability wiring at all — its LLM calls produce no trace, no spans, and no metrics.

**Goal:** every one of those 15 call sites (14 existing + `headless-turn.ts`) composes the shared helper instead of repeating the wiring, so:

- A new turn runner has to deliberately opt out of observability, not accidentally omit it.
- The #131 class of bug (an unresolved model that can never match a cost rate) can't recur at a new call site.
- Existing trace, thread-report, and message-metrics output is byte-for-byte unchanged for the 14 handlers that already record it.
- `headless-turn.ts` gets a trace for the first time.

**Out of scope (decided):**

- No new wrapper that owns an entire turn. Streaming, HITL, and error paths differ too much across call sites for one abstraction to fit (AGENTS.md, "Composition over Customization"). Each site keeps calling the shared pieces directly.
- No UI changes. Nothing the UI renders (trace source, metrics shape) changes for any existing source; the two new sources have no UI surface (see §5).
- No DB migration. `observability_traces.source` is a plain `TEXT` column with no CHECK constraint.

## 2. Approach

Pure migration onto the existing helper, plus one small helper fix and two new `TraceSource` values. No new composition pattern.

Two call-site shapes recur across the 15 sites, and each uses a different subset of the helper's surface:

1. **Streaming** (`agent.streamEvents(...)`, has a `configurable` object that already carries `thread_id`) — uses `resolveTurnModel`, `startTurnObservability`, `turnObs.attach(config)` to merge `trace_id` in (needed for the per-turn tool snapshot, #207/#214), `turnObs.obsHandler` passed into `finalizeTurn()`, and `turnObs.end(error)` in `finally`.
2. **Bare invoke** (`model.invoke(...)` or a one-off `createAgent(...).invoke(...)`, no checkpointer, no `configurable`) — uses `resolveTurnModel`, `startTurnObservability`, and `turnObs.obsHandler` passed straight into `callbacks`, with `turnObs.end(error)` replacing the hand-rolled `handleChainEnd()` + `endTrace()` pair. `.attach()` isn't used here — there's no `configurable` object to merge `trace_id` into.

## 3. Components

### 3.1 `api/src/agents/turn-observability.ts`

One change: `end()` becomes `async` and always calls `obsHandler.handleChainEnd()` before `store.endTrace()`.

```ts
export interface TurnObservability {
  traceId: string;
  obsHandler: ObservabilityCallbackHandler;
  attach<const C extends { configurable: Record<string, unknown> }>(
    config: C,
  ): C & {
    configurable: C['configurable'] & { trace_id: string };
    callbacks: ObservabilityCallbackHandler[];
  };
  // Now async: always flushes the handler's buffered spans before closing
  // the trace. A no-op for the 11 streaming/graph call sites (LangGraph's
  // own chain callbacks already flushed them) — essential for the 4 bare
  // `model.invoke()` call sites, which never fire handleChainEnd on their
  // own and previously had to call it themselves. Still idempotent: only
  // the first call writes.
  end(error?: string | null): Promise<void>;
}
```

Every existing and new caller's `finally` block changes from `turnObs.end(err)` to `await turnObs.end(err)` (all are already `async` functions).

### 3.2 `lib/llm-common-types/src/traces/types.ts`

Add `'wakeup'` and `'sub-agent-notification'` to `TraceSourceSchema`, for `headless-turn.ts`'s two trigger kinds (`HeadlessTurnParams.source: 'wakeup' | 'sub_agent'`). A local workspace package (`lib/*`) — a type-level change plus a rebuild, no publish step.

### 3.3 Streaming call sites — `stream-handler.ts`, `workspace-chat-stream-handler.ts`, `wiki-stream-handler.ts` (3 functions each: `stream*ToSse`, `resume*ToSse`, `retry*ToSse`)

Each function's inline block —

```ts
const store = getObservabilityStore();
const traceId = store.startTrace({ threadId, provider, model, source, systemPrompt });
const obsHandler = new ObservabilityCallbackHandler(
  traceId,
  store,
  obsConfig.spanOutputPreviewChars,
);
// ... streamEvents({ ...config, configurable: { ...config.configurable, trace_id: traceId }, callbacks: [obsHandler], ... })
// ... finalizeTurn(..., obsHandler, resolvedProvider, resolvedModel, ...)
// finally: store.endTrace(traceId, { totalTokens: ..., error: turnError })
```

— becomes:

```ts
const { provider: resolvedProvider, model: resolvedModel } = resolveTurnModel(
  effectiveProvider,
  effectiveModel,
);
const turnObs = startTurnObservability({
  threadId,
  provider: resolvedProvider,
  model: resolvedModel,
  source,
  systemPrompt,
});
// ... streamEvents(turnObs.attach({ ...config, version: 'v2', context: {...}, recursionLimit, signal }))
// ... finalizeTurn(..., turnObs.obsHandler, resolvedProvider, resolvedModel, ...)
// finally: await turnObs.end(turnError)
```

`resolvedProvider`/`resolvedModel` replace each function's own inline `providerConfig.name` / `effectiveModel ?? providerConfig.defaultModel!` resolution — `resolveTurnModel` is that same resolution, already shared. The 9 functions differ from each other only in what they pass for `threadId`/`systemPrompt`/HITL recovery arguments, none of which this migration touches.

### 3.4 `headless-turn.ts` (new wiring)

`runHeadlessTurn` currently builds `config` with no `trace_id`, passes no `callbacks` into `streamEvents`, and passes `undefined` where `finalizeTurn` expects an `obsHandler`. Changes:

1. `const { provider: resolvedProvider, model: resolvedModel } = resolveTurnModel(params.provider ?? env.defaultProvider, params.model);` — same resolution every other call site does; `resolveThreadAgent()` (the only caller of this path) can hand back `provider`/`model` as `undefined` when the thread has no stored preference, exactly like `stream-handler.ts`'s `effectiveProvider`/`effectiveModel`.
2. `const turnObs = startTurnObservability({ threadId, taskId, provider: resolvedProvider, model: resolvedModel, source: params.source === 'wakeup' ? 'wakeup' : 'sub-agent-notification' });` — hoisted next to `msgId`/`config` so `catch`/`finally` can reach it. No `systemPrompt`: the agent is pre-built by the caller and this function never sees it.
3. `streamEvents` options are built through `turnObs.attach(config)` instead of bare `config`.
4. `finalizeTurn(...)` gets `turnObs.obsHandler` instead of `undefined`, and `resolvedProvider`/`resolvedModel` instead of `provider`/`params.model`.
5. `finally` calls `await turnObs.end(...)`. `recordFailure`'s two branches (aborted vs. classified error) each set the same string chat/task-execution already use (`'Stopped.'` vs. `classified.message`); a local `let traceError` captures whichever ran, mirroring `task-execution.ts`'s pattern, read only in `finally`.

`providerTypeOf(provider)` (error classification) is unchanged — it takes the already-passed-in `provider`, not `resolvedProvider`, since classification needs to survive a provider that no longer resolves at all.

### 3.5 Bare-invoke call sites — `plan-generation.ts` (`runPathA`, `runPathB`), `workspace-summarizer.ts` (`maybeSummarizeWorkspace`), `threads.handlers.ts` (`generateTitleHandler`)

Each currently does:

```ts
const traceId = obsStore.startTrace({
  provider: provider ?? env.defaultProvider,
  model: modelName ?? '',
  source,
  systemPrompt,
});
const obsHandler = new ObservabilityCallbackHandler(traceId, obsStore, spanOutputPreviewChars);
// ... model.invoke(prompt, { callbacks: [obsHandler] })
// await obsHandler.handleChainEnd();  // model.invoke() never fires it on its own
// obsStore.endTrace(traceId, { totalTokens: ... })
```

Becomes:

```ts
const { provider: resolvedProvider, model: resolvedModel } = resolveTurnModel(provider, modelName);
const turnObs = startTurnObservability({
  provider: resolvedProvider,
  model: resolvedModel,
  source,
  systemPrompt,
});
// ... model.invoke(prompt, { callbacks: [turnObs.obsHandler] })
// await turnObs.end(error)   // handleChainEnd() now happens inside end() — see §3.1
```

**Behavior change, intentional:** `plan-generation.ts` currently records `model: modelName ?? ''` — a blank model whenever `modelName` is undefined, the exact #131-shaped bug. `resolveTurnModel` replaces that with an explicit resolved model, or an explicit throw if the provider has no `defaultModel`. In practice `modelName` is always concrete by the time it reaches `runPathA`/`runPathB` (the route resolves it first), so this doesn't change observed behavior — it just stops the trace from being able to silently go blank.

### 3.6 `after-agent.ts` (`runAfterAgentPipeline`)

Shares one `obsHandler` across 4 `invokeStructured()` calls (summarize/classify/extract/merge) within a single trace; no single `systemPrompt` fits (stored as `null`, unchanged — see `TraceRecordSchema`'s own comment on this). Same swap as §3.5, minus a `systemPrompt` argument: `resolveTurnModel` (this file already has its own test-escape-hatch branch for `params.llm` — kept as-is, matching `resolveProviderConfig`'s own documented can't-test-the-live-env-path limitation) + `startTurnObservability` + `turnObs.obsHandler` into each `invokeStructured` call + `await turnObs.end(error)`.

## 4. Error Handling

Unchanged per-file: every call site keeps its existing catch/finally structure (abort vs. classified error vs. graceful) and keeps deciding its own `error` string for the trace the same way it does today (`'Stopped.'` on abort, `classifyChatError(...).message` otherwise, `null` on success). The only change is that closing a trace now goes through `await turnObs.end(errorString)` instead of a hand-rolled `store.endTrace(...)` call — same argument, same idempotency guarantee, now also flushing `handleChainEnd()` first (§3.1).

`headless-turn.ts` is the one site gaining new error-path behavior: its existing `recordFailure` branches (abort vs. classified) each now also set `traceError`, read once in `finally` — the same shape `task-execution.ts` already uses for exactly this purpose.

Setup failures (`resolveTurnModel` or `startTurnObservability` throwing before a trace exists) are not special-cased anywhere: they throw inside each site's existing `try`, fail through that site's existing generic catch branch, and `turnObs` is either never assigned (caught by a hoisted `turnObs?.end()` the same way `task-execution.ts` already guards it) or the call simply never reaches the `finally` that would try to close a trace that was never opened.

## 5. UI

No changes. `'wakeup'` and `'sub-agent-notification'` have no display logic anywhere in `ui/src` to update — confirmed no code there maps `TraceSource` values to labels (only tool-access-related `sourceLabel` helpers exist, unrelated). Existing sources' rendering (thread reports, message metrics, the usage/cost dashboard) is untouched since their recorded shape doesn't change.

## 6. Testing

**`api/src/agents/turn-observability.test.ts`** (extended, `[unit]`):

- `end()` calls `obsHandler.handleChainEnd()` before `store.endTrace()`, for both a successful and a failed turn.
- A second `end()` call still doesn't overwrite the first (existing idempotency test, now against the `async` signature).

**Per migrated file** (`[unit]`/`[orchestration]`, existing test files): no new test cases are required — the dev notes' premise holds. Each file's existing tests already assert trace/metrics behavior (a trace opens with the right source/provider/model, closes with the right token total and error, `finalizeTurn` receives a handler) by stubbing `getObservabilityStore()`/`ObservabilityCallbackHandler`/`resolveProviderConfig`, the same modules `turn-observability.ts` itself calls — so they exercise the post-migration code path unchanged. Each file's test run is the regression net for that file's commit, run before moving to the next file.

**`api/src/agents/headless-turn.test.ts`** (extended, new cases, `[unit]`):

- A successful `wakeup` turn opens a trace with `source: 'wakeup'` and the resolved provider/model, and closes it with `error: null` and the correct token total.
- A successful `sub_agent` turn does the same with `source: 'sub-agent-notification'`.
- `trace_id` reaches `streamEvents`'s `configurable`.
- An aborted turn and a classified-error turn each close the trace with the matching error string (`'Stopped.'` / the classified message) instead of `null`.

**Evals:** none. No prompt, tool, or context changes — the model sees nothing different.

**TODO_LIST.md:** has no item for this work; no update needed.

## 7. Acceptance Criteria (from #219)

- Every agent turn that calls an LLM (chat, workspace chat, wiki chat, task runs, headless turns, background pipelines) records a trace with resolved provider/model, source, and total tokens. §3.3–§3.6, §6
- Every turn that finishes normally persists duration/tokens/tok-s/cost, whichever handler produced it. Unchanged for existing handlers (§4); new for `headless-turn.ts` (§3.4).
- A failed or aborted turn still closes its trace with the error recorded. §4, §6
- Adding a new turn runner doesn't require repeating trace/handler/finalize wiring. §2, §3
- Existing trace, thread-report, and message-metrics output is unchanged for handlers that already record it. §4, §5, §6
