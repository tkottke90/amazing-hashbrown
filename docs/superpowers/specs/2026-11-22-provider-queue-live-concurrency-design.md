# Provider Queue — Live Concurrency Limits — Design

**Date:** 2026-11-22
**Status:** Draft
**Related:** [2026-09-09-provider-concurrency-queue-design.md](./2026-09-09-provider-concurrency-queue-design.md), [2026-09-09-task-queue-serialization-design.md](./2026-09-09-task-queue-serialization-design.md), [ADR-0068](../../adr/0068-monitoring-green-room-pools-wait-reasons-no-deliberate-wait.md)

---

## Goal

Make a provider's `maxConcurrency` take effect without an API restart, and remove a second, currently-dormant source of accounting drift in the same gate — found while diagnosing a Monitoring page report (GLOSSARY.md § Monitoring — Provider Activity Monitor) where Digital Ocean showed `1/3` active slots and a `FULL` badge at the same time, both technically correct readings of two values that had silently gone out of sync.

---

## Problem

`ProviderQueue.getGate()` (`api/src/services/provider-queue.ts`) resolves a provider's `maxConcurrency` from config exactly once — lazily, the first time any request ever calls `acquireSlot()` for that provider name — then caches it on the `ProviderGate` for the life of the process. Nothing ever updates it afterward; there is no invalidation path anywhere in the codebase. The original design doc for this subsystem names the gap and waves it off as acceptable:

> "`maxConcurrency` changed at runtime (config reload): out of scope — providers are constructed once at boot today; no live-reload exists to hook into." (2026-09-09-provider-concurrency-queue-design.md §Error Handling & Edge Cases)

That assumption no longer holds. `routes/v1/settings.handlers.ts`'s `model-providers` slug already lets a provider's config — `maxConcurrency` included — be edited at runtime via `patchSettingsSectionHandler`, which calls `configAccessor.reload()` and refreshes `env.providers` live, in-process, no restart. `/api/v1/providers` and the Monitoring UI's provider fraction/free-dot display both read that same live `env.providers`, so they show the *new* number immediately. The gate's cached `maxConcurrency` — which also feeds the `FULL`/`BUSY`/`HEALTHY` badge via `snapshot.maxConcurrency` (`provider-activity-monitor.tsx`'s `statusOf()`) — does not, and silently keeps enforcing whatever number was live the first time that provider's gate was created. The result observed on Monitoring: the numeric fraction and free-dot count read the honest current config (3), while the badge and actual admission still enforce a stale number from earlier in the process's life (1) — two correct-by-their-own-light values that disagree, with nothing in the UI indicating they're reading different sources.

Separately, in the course of reading `provider-queue.ts` end to end, a second latent gap surfaced: `ProviderGate.activeCount` (a plain counter) and `ProviderGate.activeCallers` (a `CallerIdentity[]`) are two independently-mutated fields that only stay in lockstep because every real call site today happens to always pass a `caller` to `acquireSlot`/`withSlot` (confirmed across all 8 call sites in `agents/headless-turn.ts`, `agents/stream-handler.ts` ×3, `agents/task-execution.ts`, `agents/workspace-chat-stream-handler.ts` ×3). `releaseSlot`'s fallback path for a caller-less release (`activeCallers.pop()`) is dead code today, not a live bug — but it's exactly the kind of two-counters-that-must-agree shape that caused the `maxConcurrency` bug in spirit, so this design folds in collapsing it to one source of truth while the gate's internals are already being touched.

---

## Scope

**In scope:**

- A `ProviderQueue` method that re-resolves `maxConcurrency` for every existing gate from the live config, wired into the same post-reload callback sequence `invalidateChatAgent`/`seedProviderCosts`/`reloadTrackerRegistry` already run from.
- Draining already-queued requests immediately when a refresh raises a gate's limit.
- Defined (not accidental) behavior when a refresh lowers a gate's limit below current usage.
- Collapsing `ProviderGate.activeCount` + `ProviderGate.activeCallers` into one array, removing the drift-prone dead fallback path.

**Out of scope:**

- Preempting or cancelling an in-flight LLM call — already an explicit non-goal of the original design (2026-09-09-provider-concurrency-queue-design.md §Scope), unchanged here.
- Anything about a provider being renamed or removed from config while its gate has queued/active work — already called out as "not a real scenario in practice... not handled specially" in the original design, unchanged here.
- Distinguishing, in the Monitoring UI, a request blocked on the provider gate from a task that's merely not yet dequeued by the task scheduler — that pooling is a deliberate, already-accepted tradeoff (ADR-0068), not something this fix revisits.

---

## Design

### 1. Refresh hook, not poll-on-every-call

`ProviderQueue` gains a public `refreshLimits(): void` method.

For every gate currently in `this.gates`, it re-resolves `maxConcurrency` via the same injected `resolveMaxConcurrency(providerName)` the gate was originally built with, updates the stored value, then runs the same drain logic `releaseSlot` already uses (see §2) in case the new limit is higher than the old one. Finishes with the existing `emitActivity()` broadcast so an open Monitoring page updates live, same as any other gate mutation.

This is a push, not a poll: `getGate()` keeps caching `maxConcurrency` on first creation exactly as today, and nothing re-resolves it on the hot path of every `acquireSlot`/`releaseSlot` call. `refreshLimits()` is called exactly once per config reload, from the same place that already calls `invalidateChatAgent()`, `seedProviderCosts()`, and `reloadTrackerRegistry()` — `patchSettingsSectionHandler` and `reloadSettingsHandler` in `api/src/routes/v1/settings.handlers.ts` — as one more independent callback injected into that fixed sequence, not a provider-route-specific special case. A full settings reload (not just a `model-providers` PATCH) also triggers it, which is correct: any path that can change `env.providers` should resync the gates, the same way any reload already resyncs the tracker registry regardless of which section actually changed.

Call-site wiring mirrors the existing callbacks exactly — a new parameter on both handler functions, threaded through from `routes/v1/settings.route.ts` as `() => getProviderQueue().refreshLimits()`.

### 2. Draining on an upward refresh

`releaseSlot`'s drain loop (`while (gate.activeCount < gate.maxConcurrency && (queues not empty)) { ...dispatch... }`) is extracted into a private helper (e.g. `drainGate(gate)`) used by both `releaseSlot` and `refreshLimits`. Today, raising `maxConcurrency` without this would leave any already-queued requests stuck until some unrelated active request happened to finish and call `releaseSlot` on its own — the fix would be invisible until then. `refreshLimits()` calling the same drain immediately after updating each gate's limit means a Settings fix to a stuck provider takes effect the instant it's saved, not eventually.

### 3. Overshoot on a downward refresh

If a refresh lowers `maxConcurrency` below the gate's current active-holder count, nothing is forcibly ended — there is no way to retract an HTTP request already sent to a provider mid-generation (2026-09-09-provider-concurrency-queue-design.md §Scope, unchanged). The gate simply stops admitting new requests (`activeCount < maxConcurrency` is false) until ordinary `releaseSlot` calls, as each active request finishes naturally, bring the count back under the new cap. No new code path — this falls out of `acquireSlot`'s existing admission check once `maxConcurrency` itself can decrease.

### 4. One array, not two counters

```ts
interface ProviderGate {
  maxConcurrency: number;
  // One entry per currently-held slot — length IS activeCount, not merely
  // kept equal to it. A real CallerIdentity for an acquire that passed one,
  // an `undefined` placeholder for one that didn't (no real call site omits
  // caller today, per the audit above, but the type stays optional since
  // provider-queue.test.ts's own concurrency-mechanics tests — slot counts,
  // drain ordering — deliberately exercise acquireSlot/releaseSlot without
  // one, and shouldn't have to fabricate caller identities to do it).
  activeHolders: (CallerIdentity | undefined)[];
  syncQueue: QueuedRequest[];
  asyncQueue: QueuedRequest[];
}
```

`activeCount` is deleted as a stored field; every former read of it becomes `gate.activeHolders.length`. `acquireSlot` pushes `opts.caller` (possibly `undefined`) onto `activeHolders` instead of incrementing a counter and separately, conditionally pushing onto a second array. `releaseSlot(providerName, caller)` removes one specific matching entry — by `threadId` when `caller` is given, the first `undefined` placeholder otherwise — instead of decrementing a counter and separately popping whatever happens to be last in a differently-sized array. `getGateSnapshot()`'s `active` field keeps filtering `undefined` out exactly as it does today (`.filter((caller): caller is CallerIdentity => caller !== undefined)`) — no change to what Monitoring displays, only to how reliably the underlying count can never disagree with the array backing it.

---

## Testing

- `provider-queue.test.ts`:
  - `refreshLimits()` raises a gate's `maxConcurrency` and immediately dispatches queued entries up to the new limit, sync still draining ahead of async.
  - `refreshLimits()` lowers a gate's `maxConcurrency` below current usage: existing active holders are left untouched (no rejection, no forced release); a subsequent `acquireSlot` is not admitted until enough `releaseSlot` calls bring the count back under the new cap.
  - `refreshLimits()` on a gate that doesn't exist yet, or on an unlimited (`-1`) gate, is a no-op — mirrors `getGate`'s own lazy-create and `-1`'s existing bypass.
  - `releaseSlot` with no `caller` removes an `undefined` placeholder, not an arbitrary real caller's entry, even when real and caller-less acquires are interleaved.
  - Existing slot-accounting/drain-ordering tests continue to pass unmodified calling `acquireSlot`/`releaseSlot` without a `caller`.
- `settings.handlers.test.ts`: extend the existing call-order assertion (`'config.reload' → 'loadAgentInstructions' → 'invalidateChatAgent' → 'seedProviderCosts' → 'reloadTrackerRegistry'`) to include the new callback, for both `reloadSettingsHandler` and `patchSettingsSectionHandler`, matching that suite's existing `[orchestration]` pattern.
- No new eval or E2E coverage — this is provider-queue infrastructure, same testing posture as the original design doc.
