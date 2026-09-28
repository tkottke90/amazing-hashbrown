# Task Run Metrics (cost/duration/tok-s) — Design

**Date:** 2026-09-28
**Status:** Approved
**Issue:** [#132 — Add cost/duration/token metrics to automated task run messages](https://github.com/tkottke90/amazing-hashbrown/issues/132)
**Related:** [#131](https://github.com/tkottke90/amazing-hashbrown/issues/131) (metrics persistence shape, merged), [#219](https://github.com/tkottke90/amazing-hashbrown/issues/219) (migrate every other turn runner onto the helper introduced here)

---

## 1. Problem & Goal

Assistant messages from interactive chat show a metrics row: duration, tokens per second, estimated cost, input/output tokens. #131 persists these on the message row. Automated task runs (`api/src/agents/task-execution.ts`) get none of this, for three reasons:

1. **No observability trace.** The run never calls `startTrace`, never attaches an `ObservabilityCallbackHandler` to `agent.streamEvents()`, and passes `obsHandler: undefined` to `finalizeTurn()`. `finalizeTurn()` only computes and persists metrics when a handler is supplied. The run's LLM calls also produce no spans, so they are missing from thread reports, the per-turn tool snapshot (#207/#214), and the usage/cost dashboard (`v_usage`).
2. **Cost could never compute anyway.** The run passes `model: undefined` everywhere, so `finalizeTurn`'s cost key `` `${provider}/${model}` `` never matches a configured rate. This is the same bug #131 fixed for chat.
3. **The run's assistant rows don't record which provider/model produced them** (`recordAssistantStart` is called without them).

**Goal:** every task-run assistant turn that finishes normally persists the same metrics as a chat turn, rendered by the existing UI. Every run records an observability trace.

**Out of scope (decided):**

- **Run-level totals** (summed per run, or stored on `task_queue`). Metrics are per message only. A run that pauses for a question and resumes shows metrics under each of its assistant messages; there is no aggregate yet.
- **Migrating the existing 14 inline trace blocks and `headless-turn.ts`** onto the new helper. That is #219.
- **UI code changes.** None are needed (see §5).

## 2. Approach

The trace/handler/finalize wiring is already copy-pasted across 14 call sites (listed in #219). Adding a 15th inline copy for task runs would repeat the pattern that let this gap exist. So this work introduces a small shared helper, `api/src/agents/turn-observability.ts`, and uses it **only** in `task-execution.ts`. #219 then becomes a pure migration of the other call sites onto the same helper.

The helper is a set of small pieces that callers compose, not a wrapper that owns the whole turn. Turn runners differ too much in their streaming, HITL, and error paths for one "run a turn" abstraction to fit (AGENTS.md, "Composition over Customization").

## 3. Components

### 3.1 `api/src/agents/turn-observability.ts` (new)

```ts
// Resolves what a turn will actually run on: the provider's configured name
// and a concrete model (explicit model, else the provider's defaultModel).
// Uses resolveProviderConfig(); throws the same errors it does.
export function resolveTurnModel(
  provider?: string,
  model?: string,
): { provider: string; model: string };

export interface TurnObservability {
  traceId: string;
  obsHandler: ObservabilityCallbackHandler;
  // Returns a copy of a streamEvents config with `callbacks: [obsHandler]`
  // added and `configurable.trace_id` merged in, keeping the caller's own
  // configurable keys (thread_id, workspaceId, ...).
  attach<C extends { configurable: Record<string, unknown> }>(
    config: C,
  ): C & { callbacks: ObservabilityCallbackHandler[] };
  // endTrace() with totalTokens = obsHandler input + output tokens and the
  // given error (null = success). Idempotent: only the first call writes.
  end(error?: string | null): void;
}

export function startTurnObservability(params: {
  threadId: string;
  taskId?: string;
  provider: string; // already resolved
  model: string; // already resolved
  source: TraceSource;
  systemPrompt?: string;
}): TurnObservability;
```

Resolution and trace start are separate functions on purpose. A task run needs the resolved model _before_ `buildTaskAgent()` builds the agent, but it only has the `systemPrompt` for the trace _after_.

`startTurnObservability` uses `getObservabilityStore()` and `env.observability.spanOutputPreviewChars`, the same way the existing inline copies do.

### 3.2 `lib/llm-common-types/src/traces/types.ts`

Add `'task-run'` to `TraceSourceSchema`. The `observability_traces.source` column is plain `TEXT` with no CHECK constraint, so no migration is needed. `lib/thread-reports` routes sources other than `after-agent`/`chat` to its generic timeline branch, so nothing downstream breaks.

### 3.3 `api/src/agents/task-execution.ts`

Changes inside `runClaimed`:

1. `const { provider, model } = resolveTurnModel(env.defaultProvider);` runs inside the existing `try`, before `buildAgent`.
2. `buildAgent(runTask, provider, model, ...)` replaces `buildAgent(runTask, undefined, undefined, ...)`. What the run executes on and what it is priced as are now the same value by construction.
3. `turnObs = startTurnObservability({ threadId, taskId: task.id, provider, model, source: 'task-run', systemPrompt })`, using the `systemPrompt` that `buildTaskAgent` already returns (currently discarded). `turnObs` is hoisted next to `msgId`/`agent` so the `catch` and `finally` blocks can reach it.
4. `recordAssistantStart(threadStore, threadId, msgId, turnSentAt, provider, model)`.
5. `getProviderQueue().withSlot(provider, ...)`, and the `streamEvents` options are built through `turnObs.attach(...)` with `context: { provider, model, afterAgentEnabled: undefined }`.
6. `finalizeTurn(..., turnObs.obsHandler, provider, model, task.id, Boolean(completeTaskBox.current))` replaces the current `undefined, env.defaultProvider, undefined, ...` arguments.
7. `finally` calls `turnObs?.end(traceError)` before its existing bookkeeping (see §4 for `traceError`).

`defaultProviderType()` on the failure path is unchanged. It has to survive a misconfigured provider, which `resolveTurnModel` does not.

## 4. Error Handling

A local `let traceError: string | null = null` is set by the branches below and read by `finally`. Strings match what chat handlers already write (`'Stopped.'` on abort, the classified message on failure).

| Outcome                                                                       | Message metrics                                       | Trace `error`                                                                                     |
| ----------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `done`, `waiting_on_user`, or stopped without `complete_task` (graceful path) | Persisted by `finalizeTurn`                           | `null`. Trailing off is a _task_ failure, already recorded in the run summary, not an LLM failure |
| Thrown `GraphInterrupt`, recovered                                            | None (`recoverThrownInterrupt`, same as chat)         | `null`                                                                                            |
| Thrown `GraphInterrupt`, recovery failed                                      | None                                                  | `'Failed to record the approval prompt.'`                                                         |
| `GraphRecursionError`                                                         | None (`finalizeAssistant` without metrics, unchanged) | `'Ran out of steps before completing this task.'`                                                 |
| Any other error                                                               | None (`failAssistant`)                                | `classifyChatError(err, defaultProviderType()).message`                                           |
| Cancel / pause / take-over                                                    | None (`failAssistant`)                                | `'Stopped.'`                                                                                      |

- **Setup failures are not special-cased.** If `resolveTurnModel` or `startTurnObservability` throws, it does so inside the existing `try`. The run fails through the generic branch, the same way a misconfigured provider fails `buildTaskAgent` today. No trace exists in that case, so `turnObs?.end()` is a no-op.
- **`end()` is idempotent**, so it is safe regardless of which branch ran.
- **Duration semantics are unchanged from chat.** `durationMs` comes from `startedAt`, which starts before `withSlot`, so it includes time waiting in the provider queue. Tok/s uses `obsHandler.turnDurationMs`, which is LLM time only.
- **Missing cost rate:** `finalizeTurn` omits `cost.dollars` and still persists duration, tok/s, and tokens. This is the existing behavior; no new code.

## 5. UI

No code changes. `TaskRunView` (`ui/src/pages/chat/task-run-view.tsx`) renders messages through `ThreadMessageItem` → `AssistantMessage`, which already renders persisted metrics (#131). The E2E test in §6 verifies this rather than assuming it.

The live `usage_stats` SSE event `finalizeTurn` emits goes to the run's sink, which normally has no browser attached. That's harmless, and the persisted payload is what the run view reads when it polls.

## 6. Testing

**`api/src/agents/turn-observability.test.ts`** (new, `[unit]`):

- `resolveTurnModel()` with no arguments returns the default provider's name and its `defaultModel`.
- An explicit model overrides `defaultModel`; an explicit provider resolves to that provider's own `defaultModel`.
- `startTurnObservability` opens a trace with the given source, taskId, provider, and model (stub store; assert on the recorded trace, not on calls).
- `attach` keeps the caller's `thread_id`/`workspaceId`, adds `trace_id`, and puts the handler in `callbacks`.
- `end` records `totalTokens = input + output` and the error string. A second `end` call does not overwrite the first.

**`api/src/agents/task-execution.test.ts`** (extended, `[orchestration]`), using the existing `buildTaskAgent` seam. The fake agent's `streamEvents` calls `options.callbacks[0]`'s `handleLLMStart`/`handleLLMEnd` with a canned `LLMResult`, so token totals are non-zero:

- After a completed run, the assistant row's payload has `durationMs`, `usage.inputTokens`/`outputTokens`, and `cost.tokensPerSecond`.
- With `env.costs["<default provider>/<its defaultModel>"]` configured, `cost.dollars` equals the expected value. With no rate, `cost.dollars` is absent while duration, tok/s, and tokens are still present.
- The assistant row records the resolved provider and model.
- The run's trace has `source: 'task-run'` and the task's id, and is closed: `error: null` on success, the classified message on a stream failure, `'Stopped.'` on cancel.
- `buildTaskAgent` receives the resolved provider and model, not `undefined`.

**`e2e/tests/task-runs.spec.ts`** (extended, `@user-workflow`, CI-safe): the spec already mocks `GET /api/v1/threads/e2e-run-thread-1`. Add metrics (`durationMs`, `usage`, `cost`) to one assistant message in that mock, and add a suite step: _Open a finished run → the metrics row (duration, tok/s, dollar cost, token counts) shows under the agent's message._

**Evals:** none. Nothing the model sees changes: prompt, tools, and context are identical. The EDD rules don't apply.

**TODO_LIST.md:** has no item for this work; no update needed.

## 7. Acceptance Criteria (from #132)

- Task-run turns compute duration, tokens per second, input/output tokens, and estimated cost (when a rate exists for the resolved provider/model). §3.3, §6
- Metrics are persisted on the run's assistant message rows in the #131 shape and survive reload. §3.3 step 6, §6
- Metrics render under task-run assistant messages in the run view. §5, §6 E2E
- With no configured rate, duration, tok/s, and tokens still show; the dollar figure is omitted. §4, §6
