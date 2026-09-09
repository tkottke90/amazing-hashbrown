# Per-Provider Concurrency Queue — Design

**Date:** 2026-09-09
**Status:** Draft
**Related:** [2026-09-09-task-queue-serialization-design.md](./2026-09-09-task-queue-serialization-design.md), [2026-09-09-sub-agent-tooling-design.md](./2026-09-09-sub-agent-tooling-design.md)

---

## Goal

Let low-concurrency local inference engines (Ollama, llama.cpp/Lemonade — typically max concurrency 1) coexist with high-concurrency cloud providers (Anthropic, DigitalOcean AI Inference), without either starving the other or overloading the local engine into OOM/20x-slowdown territory.

---

## Problem

`TaskScheduler` today pauses **all** task execution, globally, the instant any chat turn starts anywhere (`workspace-chat-stream-handler.ts:97`, `stream-handler.ts:759/936/1100`) — regardless of which provider the chat turn or the paused task actually target. A chat message on Provider A blocks a task running on Provider B for no real reason.

Meanwhile, there is **no concurrency control at all** at the provider level. Nothing stops two different threads from sending simultaneous requests to the same Ollama instance — the global chat-pause behavior only accidentally prevents this most of the time, by serializing almost everything.

---

## Scope

**In scope:**

- A per-provider request gate: N concurrent slots (config-driven, default 1), `-1` for unlimited.
- Two priority lanes per provider — sync (interactive chat) and async (task/sub-agent) — sync always dispatched ahead of async when both are waiting.
- An SSE signal so a sync request waiting on a full provider shows the user "waiting for provider capacity," not a silent hang or a false "generating" state.
- Adding the config field to the Settings page's provider add/edit form, so it's actually reachable without hand-editing `config.yaml`.

**Out of scope:**

- Removing `TaskScheduler`'s global run-guard — that's [task-queue-serialization-design.md](./2026-09-09-task-queue-serialization-design.md).
- Anything about *what* a request is (task vs. sub-agent vs. chat) beyond its sync/async classification — that's the callers' job.
- Persistence/resume of queue state across a restart — explicitly not needed (see Design §4).
- Preempting an in-flight request. You cannot cancel a request already sent to llama.cpp mid-generation; priority only governs which *queued* request is dispatched next, never interrupts one already running.

---

## Design

### 1. Data structure — one gate per provider

```ts
interface ProviderGate {
  maxConcurrency: number; // from config; -1 = unlimited
  activeCount: number;
  syncQueue: QueuedRequest[];
  asyncQueue: QueuedRequest[];
}
```

One `ProviderGate` instance per configured provider (`ProviderConfig.name`), held in a module-level `Map<string, ProviderGate>` inside a new `api/src/services/provider-queue.ts`. Not persisted — see §4.

### 2. Admission — `acquireSlot(providerName, kind: 'sync' | 'async'): Promise<void>`

```
if maxConcurrency === -1:
    resolve immediately — never touches activeCount or the queues
else if activeCount < maxConcurrency:
    activeCount++
    resolve immediately
else:
    push { resolve, kind } onto syncQueue or asyncQueue
    (caller awaits; resolves once dispatched — see §3)
```

Unlimited providers bypass the gate entirely, by design — no accounting overhead, and no shared state that a constrained provider's bug could wedge for a cloud provider that never needed gating in the first place.

### 3. Release — `releaseSlot(providerName)`, called in a `finally` after every request

```
activeCount--
while activeCount < maxConcurrency and (syncQueue.length or asyncQueue.length):
    next = syncQueue.length ? syncQueue.shift() : asyncQueue.shift()
    activeCount++
    next.resolve()
```

A `while`, not a single pop: one release can free capacity for more than one queued request when `maxConcurrency > 1` (e.g. 3 requests queued, 3 slots simultaneously vacated). Sync always drains ahead of async, every iteration of the loop — not just on the first pop — so a burst of async completions doesn't let a later-arriving sync request get skipped over mid-drain.

### 4. Integration point — wraps the chat model, not the task/turn

`acquireSlot`/`releaseSlot` wrap the actual outbound LLM call — where `chat-agent.ts` binds the provider's `ChatOllama`/`ChatOpenAI`/`ChatAnthropic` instance into the graph — not `executeTask()` or a whole chat turn. A task's agent loop makes many sequential LLM calls across tool-execution gaps; gating at task-start granularity would let one long task monopolize a single-slot local provider for its entire run, defeating the point. Gating per-call means a sync chat request can slot in between a task's own turns.

Consequence: **in-memory only, no persistence.** A slot claim's lifetime is one outbound request (sub-second to low-minutes) — there is nothing meaningful to resume after a crash; an in-flight LLM call is simply dead if the process restarts, same as it is today. `activeCount`/queues reset to empty on boot.

### 5. Sync vs. async classification

The caller decides `kind` when it calls `acquireSlot`. Interactive chat/workspace-chat turns and sub-agent-notification turns (see sub-agent design) are `'sync'`; `executeTask()`'s own LLM calls (for both user tasks and sub-agent runs) are `'async'`. This is a static property of the call site, not something inferred at runtime.

### 6. Waiting-for-capacity signal (req: user must see this, not a stalled "generating" state)

New SSE event, `provider_wait`, emitted the moment a **sync** request is pushed onto `syncQueue` (never for async — no live user is watching a task's turn) and again when it's dispatched:

```ts
{ type: 'provider_wait', provider: string, waiting: boolean }
```

Frontend renders this as a distinct "waiting for [provider]…" state, replacing whatever would otherwise read as a silent/generating chat bubble.

### 7. Configuration

```ts
export const ProviderSchema = z.object({
  name: z.string(),
  type: z.enum(['ollama', 'openai', 'anthropic']),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  defaultModel: z.string().optional(),
  models: z.array(ModelPricingSchema).optional(),
  maxConcurrency: z.number().int().default(1), // -1 = unlimited
});
```

Defaults to `1` — every existing config, unmodified, keeps today's de-facto single-flight behavior for that provider.

### 8. Settings UI

`ui/src/pages/settings/provider-modal.tsx` is the add/edit form backing `model-providers-panel.tsx` (fields today: `baseUrl`, `apiKey`, `defaultModel`, per `provider-modal.tsx:21-23/66-68`) — needs a new `maxConcurrency` numeric field wired the same way (a `useSignal`, included in the payload built at submit, `provider-modal.tsx:108-110`). `-1` needs to be explained in the UI (e.g. helper text: "-1 = unlimited") rather than left to guesswork, since it's a magic value. `providers-api.ts`/`use-providers.ts` need their client-side `ProviderConfig`-shaped types extended to match the new server-side schema field from §7.

---

## Error Handling & Edge Cases

- **A queued request's caller gives up (aborted turn, cancelled task):** the queue entry must be removed on abort, not just left to resolve into a dead request later. `acquireSlot`'s promise needs an abort-signal-aware reject path that also splices the entry out of whichever queue holds it.
- **`maxConcurrency` changed at runtime (config reload):** out of scope — providers are constructed once at boot today (`provider-factory.ts`); no live-reload exists to hook into.
- **Provider removed from config while requests are queued:** not a real scenario in practice (config is static per boot), not handled specially.

---

## Testing

- Unit tests for `provider-queue.ts` in isolation: slot accounting under N=1, N=3, and `-1`; sync-before-async drain ordering across single and multi-slot releases; abort removes a queued entry without resolving it.
- Integration: two simulated concurrent chat turns against a `maxConcurrency: 1` provider — second one observably waits (via `provider_wait`) rather than firing a second concurrent request.
- No new eval coverage needed — this is infrastructure, not model-facing behavior.
