# Plan — Task Run Metrics (#132)

## Context

Automated task runs (`api/src/agents/task-execution.ts`) never open an observability trace and pass `obsHandler: undefined` / `model: undefined` to `finalizeTurn()`. As a result, task-run assistant messages carry no duration/tok-s/token/cost metrics, and their LLM spend doesn't appear in thread reports or the usage dashboard. The approved spec (`docs/superpowers/specs/2026-09-28-task-run-metrics-design.md`) fixes this with a small composable helper, `api/src/agents/turn-observability.ts`, used **only** by `task-execution.ts`. Migrating the 14 other inline copies is #219. Scope: per-message metrics only, and no UI code changes.

Branch: `claude/busy-tesla-cmh2ak` (spec already committed there).

## Two gotchas found while reading the tests

1. **`task-execution.test.ts` runs with `providers: []` and `defaultProvider: ''`.** Once `resolveTurnModel()` is on the run path, `resolveProviderConfig()` throws "No providers configured", and every existing test would fail through the generic error branch. Fix: the top-level `beforeEach` sets a test provider (`configManager.set('providers', [{ name: 'task-test-provider', type: 'ollama', baseUrl: 'http://localhost:11434', defaultModel: 'task-test-model' }])` + `configManager.set('defaultProvider', 'task-test-provider')`), and the top-level `afterEach` resets both. The existing "error classification" `describe` already overrides both and still works. Nothing actually connects to Ollama because `buildTaskAgent` is stubbed.
2. **The observability store must be booted.** The top-level `beforeEach` calls `bootObservability(db)` (from `api/src/services/observability.ts`), following `stream-handler.test.ts:1419`.

A third, minor one: `TraceSourceSchema` lives in `lib/llm-common-types` and `api` consumes its **built `dist/`**. Rebuild with `npm run build -w @tkottke90/llm-common-types` after editing it, or `'task-run'` won't typecheck in `api`.

## Steps (TDD order)

### 1. Trace source enum

- `lib/llm-common-types/src/traces/types.ts`: add `'task-run'` to `TraceSourceSchema`, with a one-line comment (automated task runs, `task-execution.ts`).
- Rebuild the lib (see above).
- Update the stale source list in the comment at `lib/observability/src/store.ts:230` only if it tries to be exhaustive (it lists 3 of 7 today). Otherwise leave it alone.

### 2. Helper: `api/src/agents/turn-observability.ts` + `turn-observability.test.ts`

Write the tests first (`[unit]`, Mocha/Chai, with a real `ObservabilityStore` on a temp DB via `bootObservability`, same as `after-agent.test.ts:145`, and providers set via `configManager`):

- `resolveTurnModel()` with no args → default provider's `name` + `defaultModel`
- an explicit model overrides `defaultModel`; an explicit provider → that provider's own `defaultModel`
- `startTurnObservability()` → `getObservabilityStore().getTrace(traceId)` has the given `source`, `taskId`, `threadId`, `provider`, `model`, `systemPrompt`
- `attach({ configurable: { thread_id, workspaceId } })` keeps both keys, adds `trace_id === traceId`, and `callbacks` contains `obsHandler`; the input object isn't mutated
- `end('boom')` after setting `obsHandler.totalInputTokens/OutputTokens` → the trace's `totalTokens` equals the sum, `error === 'boom'`, `endedAt` is set
- a second `end(null)` leaves `error === 'boom'`

Implementation (shape as in spec §3.1):

- `resolveTurnModel(provider?, model?)` → `const cfg = resolveProviderConfig(provider)` (`api/src/services/provider-factory.ts:178`); return `{ provider: cfg.name, model: model ?? cfg.defaultModel }`. If neither exists, throw the same message `createProviderFromConfig` uses (`provider-factory.ts:47`).
- `startTurnObservability(p)` → `getObservabilityStore().startTrace({...})`, `new ObservabilityCallbackHandler(traceId, store, env.observability.spanOutputPreviewChars)` (`api/src/agents/observability-handler.ts`), and return `{ traceId, obsHandler, attach, end }` with a `closed` flag guarding `end`.

### 3. Wire into `api/src/agents/task-execution.ts`

Write the orchestration tests first (step 4), then change `runClaimed` as in spec §3.3:

- hoist `let turnObs: TurnObservability | undefined` and `let traceError: string | null = null` next to `msgId`/`agent` (~line 254)
- in the `try`, before `buildAgent`: `const { provider, model } = resolveTurnModel(env.defaultProvider)`
- `buildAgent(runTask, provider, model, ...)` and keep its `systemPrompt` (destructure `{ agent, systemPrompt }` instead of `.agent`)
- `turnObs = startTurnObservability({ threadId, taskId: task.id, provider, model, source: 'task-run', systemPrompt })`
- `recordAssistantStart(threadStore, threadId, msgId, turnSentAt, provider, model)`
- `withSlot(provider, ...)`; `streamEvents(input, turnObs.attach({ ...resolvedConfig, version: 'v2', recursionLimit, signal, context: { provider, model, afterAgentEnabled: undefined } }))`. Capture `turnObs` in a local const for the closure, the same way `resolvedAgent` is captured.
- `finalizeTurn(..., turnObs.obsHandler, provider, model, task.id, Boolean(completeTaskBox.current))`; replace the stale comment at lines 387-390
- `catch`: set `traceError` per spec §4 — `'Stopped.'` when `intent` is set; `'Failed to record the approval prompt.'` in the unrecovered GraphInterrupt branch; `'Ran out of steps before completing this task.'` for `GraphRecursionError`; `classifyChatError(err, defaultProviderType()).message` otherwise (reuse the `classified` value already computed there, and hoist it so it's computed once)
- `finally`: `turnObs?.end(traceError)` as the first statement
- update the file's header comment on `defaultProviderType()` (lines 50-52): it's still used on the failure path; the main path now resolves through `resolveTurnModel`

### 4. Orchestration tests: `api/src/agents/task-execution.test.ts`

- Top-level `beforeEach`/`afterEach`: the provider and `bootObservability` setup from the gotchas above.
- New helper `fakeMeteredAgent(events, { inputTokens, outputTokens })`: like `fakeAgent`, but `streamEvents(_input, options)` calls `options.callbacks[0].handleLLMStart({} as any, [], 'run-1')`, awaits a 5 ms `setTimeout` (so `turnDurationMs > 0` and tok/s is defined), calls `handleLLMEnd({ generations: [[{ text: 'x' }]], llmOutput: { usage_metadata: { input_tokens, output_tokens } } }, 'run-1')` and then `handleChainEnd()`, and then yields `events`. Also records the `options` it received so a test can assert on them.
- New `describe('usage metrics and trace (issue #132)')`, all `[orchestration]`:
  - a completed run's assistant row payload has `durationMs` (number), `usage` `{ inputTokens: 1000, outputTokens: 500 }`, `cost.tokensPerSecond` (number)
  - with `configManager.set('costs', { 'task-test-provider/task-test-model': { inputPer1kTokens: 0.01, outputPer1kTokens: 0.02, ... } })` → `cost.dollars` is about `0.02`; reset `costs` to `{}` in `afterEach`. Check `CostEntrySchema` in `api/src/config/env.ts:246` for the required fields.
  - with no rate → `cost.dollars` absent, while `durationMs`, `usage` and `cost.tokensPerSecond` are present
  - the assistant row records `provider === 'task-test-provider'`, `model === 'task-test-model'`
  - `getObservabilityStore().find({ threadId: runThreadOf(entry) })` → exactly one trace, `source: 'task-run'`, `taskId: entry.task.id`, `endedAt` set, `error: null`
  - a stream failure (`fakeThrowingAgent`) → trace `error` equals the run summary's classified message
  - cancel (use the existing abort-test pattern at ~line 776) → trace `error === 'Stopped.'`
  - `buildTaskAgent` is called with `('task-test-provider', 'task-test-model')`: capture the args in a wrapper around `fakeBuildTaskAgent`
  - `streamEvents` options carry `configurable.trace_id` equal to the trace's id (needed for #207/#214 tool snapshots)
- Test names end with their `[orchestration]` tag, and assertion messages explain why.

### 5. E2E: `e2e/tests/task-runs.spec.ts`

- Add a step to the `suite` object: action "Open a finished run", expectedOutcome "The metrics row (duration, tok/s, dollar cost, token counts) shows under the agent's message".
- New test (`@user-workflow`, no `@llm`): `mockRunThread(page, runThreadBody({ messages: [{ ...assistant, durationMs: 2300, usage: { inputTokens: 512, outputTokens: 128 }, cost: { tokensPerSecond: 14.2, dollars: 0.0031 } }] }))`, open `/chat/e2e-run-thread-1`, and assert `getByText('2.3s')`, `'14.2 tok/s'`, `'$0.0031'` and the token-count text are visible inside `getByTestId('task-run-view')`. Check the exact token-count string format in `ui/src/components/assistant-message.tsx` (~line 150). Follow the existing tests' `pauseBeforeAction` / `testInfo` conventions.

### 6. Housekeeping

- `TODO_LIST.md` has no item for this work (checked), so no change.
- `api/AGENTS.md` "Automated task runs": add one bullet saying task runs record an observability trace (`source: 'task-run'`) through `turn-observability.ts` and that new turn runners should use that helper (see #219).

## Critical files

- new: `api/src/agents/turn-observability.ts`, `api/src/agents/turn-observability.test.ts`
- modified: `api/src/agents/task-execution.ts`, `api/src/agents/task-execution.test.ts`, `lib/llm-common-types/src/traces/types.ts`, `e2e/tests/task-runs.spec.ts`, `api/AGENTS.md`

Reused as is: `resolveProviderConfig` (`api/src/services/provider-factory.ts`), `getObservabilityStore`/`bootObservability` (`api/src/services/observability.ts`), `ObservabilityCallbackHandler` (`api/src/agents/observability-handler.ts`), `finalizeTurn`'s existing metrics path (`api/src/agents/stream-handler.ts:541`), `finalizeAssistant(..., metrics)` (`api/src/agents/thread-message-writer.ts`), `classifyChatError`.

## Verification

1. `npm run build -w @tkottke90/llm-common-types`
2. `npm test` (api Mocha + ui Jest): the new unit and orchestration tests pass, and **all existing `task-execution.test.ts` tests still pass** (this proves the provider/observability test setup is right)
3. `npm run test:e2e:ci`: `task-runs.spec.ts` passes, including the new metrics step
4. `npm run lint` and `npx prettier --check .`
5. `npm run build` (both workspaces typecheck)
6. Commit ("Add cost/duration/token metrics to task run messages (#132)") and push to `claude/busy-tesla-cmh2ak`. No PR unless asked.
