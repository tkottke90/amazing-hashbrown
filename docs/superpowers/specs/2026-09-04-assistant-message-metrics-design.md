# Assistant Message Metrics (cost/duration/tok-s) — Design

**Date:** 2026-09-04
**Status:** Approved
**Issue:** [#131 — Assistant message metrics (cost/duration/tok-s) missing live and never persisted](https://github.com/tkottke90/amazing-hashbrown/issues/131)

---

## 1. Problem & Goal

Assistant messages should show a metrics row in this format:

```
2.3s   14.2 tok/s   $0.0031   (512 in / 128 out)
```

Two independent bugs currently break this:

1. **Cost never computes**, even with a rate configured. `effectiveProvider`/`effectiveModel` (computed in each streaming handler as `provider ?? threadMeta?.provider ?? undefined`, no further fallback) stay `undefined` whenever a thread relies on the app's default provider/model — the common case. The cost-lookup key (`` `${effectiveProvider}/${effectiveModel}` ``) then resolves to `null` regardless of whether a matching rate is configured, because the *real* resolved provider/model (computed internally by `provider-factory.ts`'s `createProviderFromConfig` via `model ?? config.defaultModel`) never gets reported back.
2. **No metrics survive reload.** `finalizeAssistant` (`api/src/agents/thread-message-writer.ts`) only ever persists `{ content, thoughtContent, sentAt }`. Duration/tokens/cost exist only in the live `usage_stats` SSE event and the client's in-memory signal.

Both bugs are duplicated identically across all three interactive chat surfaces — main chat (`stream-handler.ts`), workspace chat (`workspace-chat-stream-handler.ts`), and wiki chat (`wiki-stream-handler.ts`) — which all render through the same shared `AssistantMessage` component via `use-thread.ts`. This design fixes all three.

**A third instance of bug 1 also undercounts the aggregate usage dashboard, not just per-message display.** `after-agent.ts`'s `runAfterAgentPipeline` (the background wiki summarize/classify/extract/write pipeline that fires after a chat turn completes) opens its own observability trace — `store.startTrace({ provider: provider ?? env.defaultProvider, model: model ?? '', source: 'after-agent', ... })` — independent of the triggering chat turn's trace, and attaches an `ObservabilityCallbackHandler` to its four LLM calls. Those calls generate real `observability_spans` rows that feed `v_usage` (the usage/cost dashboard fed by `lib/observability/cost-store.ts`). When the triggering thread relies on the app's default provider/model (`model` arrives `undefined` via `runtime.context?.model`), this trace's `model: model ?? ''` records an empty string, which can never match a configured cost rate in `v_usage`'s join — so AfterAgent's real, metered token spend is recorded in the dashboard at **$0**, not merely "not shown." This is fixed here too (§2), since it's the identical root cause already being fixed at the other three call sites, not a new capability.

Automated task runs (`task-execution.ts`) deliberately show no metrics today (`obsHandler: undefined` passed to `finalizeTurn`) — that's unchanged by this design and tracked separately in [#132](https://github.com/tkottke90/amazing-hashbrown/issues/132). Unlike the AfterAgent trace above, this is a genuine missing-capability gap (no trace at all), not a resolution bug in an existing one — hence the separate issue rather than folding it in here.

A related finding during investigation turned out to be a non-issue: `CostEntry`'s `inputScale`/`outputScale` fields (`'1k'` | `'1M'`) carry no computational meaning — `inputPer1kTokens`/`outputPer1kTokens` are already normalized to a true per-1,000-token rate at settings-entry time (`ScaledCostInput`'s `displayToPer1k()`), confirmed by `config.yaml.example`'s GLM entry (`inputScale: 1M`, `inputPer1kTokens: 0.0014` — the correct per-1k equivalent of $1.40/M). The existing `/1000` math in `finalizeTurn` and in `lib/observability/cost-store.ts`'s `v_usage` view is already correct. No change needed there.

---

## 2. Fix 1 — Resolve the real provider/model once, use it everywhere

`provider-factory.ts`'s private `resolveProviderConfig(name?)` already implements the exact fallback chain the real LLM call uses (`name ?? env.defaultProvider ?? providers[0].name`, then looks up the matching `ProviderConfig`). Exporting it lets every handler compute the *actual* resolved identity right after building the agent, instead of re-deriving an incomplete guess:

```ts
const providerConfig = resolveProviderConfig(effectiveProvider);
const resolvedProvider = providerConfig.name;
const resolvedModel = effectiveModel ?? providerConfig.defaultModel!;
```

(`defaultModel` is guaranteed non-null here — `getChatAgent`/`getWorkspaceChatAgent`/`getWikiIngestionAgent` would already have thrown building the agent otherwise.)

`resolvedProvider`/`resolvedModel` replace `effectiveProvider`/`effectiveModel` in exactly three places, in each of the affected handler functions:

- **`recordAssistantStart`'s `provider`/`model` args** — the DB row stores what actually ran. (Wiki chat's `recordAssistantStart` calls don't even pass these today — fixed as part of this change.)
- **`store.startTrace({ provider, model })`** — fixes the observability trace's existing `model: effectiveModel ?? ''` blank-model bug as a side effect.
- **`finalizeTurn`'s provider/model params** — used for the cost-rate lookup key. `finalizeTurn`'s signature tightens these two params from `string | undefined` to `string` (every caller now always has a resolved value).

**Explicitly not changed:** the `context: { provider, model }` object passed into `agent.streamEvents(...)`. That has its own documented AfterAgent nullish-vs-empty-string invariant (see the existing code comments on those call sites) that is orthogonal to this bug — touching it risks an unrelated regression for no benefit to cost/persistence.

Affected call sites (all get the 3-line resolve block added):

| File | Functions |
|---|---|
| `api/src/agents/stream-handler.ts` | `streamChatToSse`, `resumeChatToSse`, `retryChatToSse` |
| `api/src/agents/workspace-chat-stream-handler.ts` | `streamWorkspaceChatToSse`, `resumeWorkspaceChatToSse`, `retryWorkspaceChatToSse` |
| `api/src/agents/wiki-stream-handler.ts` | `streamWikiChatToSse`, `resumeWikiChatToSse`, `retryWikiChatToSse` |
| `api/src/agents/after-agent.ts` | `runAfterAgentPipeline` |

`task-execution.ts`'s `finalizeTurn` call is untouched (still passes `undefined, undefined, undefined` for `obsHandler`/provider/model — see [#132](https://github.com/tkottke90/amazing-hashbrown/issues/132)).

### `runAfterAgentPipeline`'s narrower fix

Unlike the other three call sites, `runAfterAgentPipeline` isn't a visible chat turn — it has no assistant message row to update and no live SSE metrics event to emit. Only the trace-identity half of Fix 1 applies here, added right before its existing `store.startTrace(...)` call:

```ts
const providerConfig = resolveProviderConfig(provider);
const resolvedProvider = providerConfig.name;
const resolvedModel = model ?? providerConfig.defaultModel!;
```

with `resolvedProvider`/`resolvedModel` replacing `provider ?? env.defaultProvider`/`model ?? ''` in that `startTrace` call. This is entirely local to `after-agent.ts` — it does not touch how `provider`/`model` are read from `runtime.context` in `chat-agent.ts`'s `afterAgentMiddleware`, and does not touch the `context: { provider, model }` object built upstream in the three streaming handlers. It simply stops trusting a possibly-blank value for its own trace and resolves the real identity itself, the same way the other three call sites now do.

---

## 3. Fix 2 — Persist the metrics

`finalizeTurn` already computes `durationMs`, `tokensPerSecond`, `inputTokens`, `outputTokens`, and `estimatedCostUsd` to build the live `usage_stats` SSE event — but only *after* it has already called `finalizeAssistant` to write the row. Reorder so the same numbers land in the DB in the same write:

- Compute `durationMs = Date.now() - startedAt` once, near the top of `finalizeTurn`, before `finalizeAssistant` is called. This value is then reused for the later `stream_done` SSE event too (previously computed a second time via a second `Date.now() - startedAt` call) — one source of truth instead of two independent timestamps.
- `finalizeAssistant` (`thread-message-writer.ts`) gains a new optional 8th parameter:

```ts
export function finalizeAssistant(
  store: ThreadStore,
  threadId: string,
  id: string,
  content: string,
  thoughtContent: string,
  sentAt: string,
  checkpointId: string | null,
  metrics?: {
    durationMs: number;
    usage: { inputTokens: number; outputTokens: number };
    cost?: { tokensPerSecond?: number; dollars?: number };
  },
): void
```

  merged into the same `payload` object it already writes. Purely additive: every existing call site (including the three `GraphRecursionError` fallback paths in each handler) omits the new param and is unaffected.

- The `metrics` shape is written pre-formed to match the client's `AssistantThreadMessage` type exactly (see §4) — `toClientMessage` (`threads.handlers.ts`) spreads `payload` straight onto the client message with no transformation, so storing it pre-shaped means zero new mapping code on read.
- `finalizeTurn` only builds and passes `metrics` when `obsHandler` is present — same guard already used for the live `usage_stats` event, so behavior for task runs (no `obsHandler`) is unchanged: no metrics computed, none persisted, matching today.

---

## 4. Fix 3 — Display format

`ui/src/types/thread-message.ts`'s `assistant` variant gains one additive field, parallel to the existing `cost` field (not folded into it — token counts and cost are different concepts):

```ts
durationMs?: number;
cost?: { tokensPerSecond?: number; dollars?: number };
usage?: { inputTokens: number; outputTokens: number };
```

`use-thread.ts`'s `usage_stats` SSE handler sets `usage` from the event's `evt.inputTokens`/`evt.outputTokens` — both fields already exist on `ChatSSEEvent`'s `usage_stats` schema (`lib/llm-common-types/src/chat/sse-events.ts`), so no wire-format change is needed.

`assistant-message.tsx`'s metrics row renders:

```
2.3s   14.2 tok/s   $0.0031   (512 in / 128 out)
```

- Duration, tok/s, and the token breakdown render whenever the turn finished with usage data — including when no cost rate is configured (e.g. a local Ollama model), in which case the `$` figure is simply omitted. This matches today's existing partial-rendering behavior for duration/tok-s.
- Token counts use `.toLocaleString()` for thousands separators (e.g. `1,234 in / 567 out`). Duration/tok-s/cost formatting is unchanged from today.
- On reload, older persisted messages without `usage`/`cost`/`durationMs` (written before this change) simply render without the metrics row, same as any other optional field in `ThreadMessage`.

---

## 5. Fix 4 — Remove `ChatMessage`'s unused cost/duration capability

`ui/src/components/chat-message.tsx`'s generic `ChatMessage` component has fully-implemented, tested `cost`/`duration` props (its own independent cost/duration rendering, separate from `AssistantMessage`'s). Confirmed via search: the only production consumer of `<ChatMessage>` is `ThreadMessageItem`'s `'user'` case (`thread-message.tsx`), which never passes `cost` or `duration` — those props exist only in this component's own tests and docs example. This is a speculative capability with no real caller, so it's removed as part of this change rather than left to bit-rot further:

- **`chat-message.tsx`**: delete the `ChatMessageCost` interface, the `cost`/`duration` props from `ChatMessageProps`, the `formatDuration` helper, and the `cost`/`timing` grid-area render blocks. The bottom row's grid simplifies to just the actions area (mirrored alignment is unaffected — that logic already lives on the actions block itself, independent of the cost/timing columns).
- **`ui/test/chat-message.test.tsx`**: delete the `cost section` and `timing section` `describe` blocks.
- **`ui/src/components/chat-message.md`**: remove the `ChatMessageCost` export row and its dedicated section, the `cost`/`duration` prop rows, the "Cost stacking" section, and drop `duration`/`cost` from the "Assistant message with cost and actions" usage example (rename that example to drop the "with cost" framing).

No behavior change for any real user-facing surface — this capability was never exercised.

---

## 6. Out of Scope

- **Task-run metrics** — tracked in [#132](https://github.com/tkottke90/amazing-hashbrown/issues/132), depends on this design's persistence shape landing first. Genuinely missing capability (no trace, no metrics at all), not a resolution bug in an existing one — hence a separate issue rather than folding in here like the AfterAgent trace fix was.
- **Cost-scale math** — investigated, confirmed not a bug (see §1). No change.
- **`context: { provider, model }`'s nullish-vs-empty-string handling and `chat-agent.ts`'s `afterAgentMiddleware` context read** — deliberately untouched (see §2). The AfterAgent trace fix above is local to `after-agent.ts` and doesn't touch this upstream contract.

---

## 7. Testing

- `api/src/agents/stream-handler.test.ts` — extend `finalizeTurn` tests to assert the persisted `payload` now includes `durationMs`/`usage`/`cost` when `obsHandler` is supplied, and omits them when it isn't (task-run parity check).
- New/extended unit coverage for `resolveProviderConfig` being exported and used to compute `resolvedProvider`/`resolvedModel`, including the case where no explicit provider/model was ever supplied (falls through to `env.defaultProvider` + that provider's `defaultModel`).
- `after-agent.test.ts` — `runAfterAgentPipeline`'s `startTrace` call records the real resolved provider/model (not a blank string) when no explicit provider/model was supplied, so a configured cost rate for the default provider/model shows up in `v_usage` for AfterAgent-sourced spans.
- `thread-message-writer.test.ts` (or equivalent) — `finalizeAssistant` with and without the new `metrics` param.
- `ui/test/assistant-message.test.tsx` — new cases for the token-breakdown display, and for partial rendering when `cost` is absent but `usage`/`durationMs` are present.
- `ui/test/chat-message.test.tsx` — removal of the deleted `cost section`/`timing section` tests; confirm remaining tests still pass with the simplified grid.
- Manual verification: a chat turn against the app's default provider (no explicit provider/model on the thread) shows a non-empty `$` figure when a rate is configured for that default, and the metrics row survives a page reload.
