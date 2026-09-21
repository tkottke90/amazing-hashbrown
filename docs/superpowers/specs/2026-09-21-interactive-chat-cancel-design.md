# Interactive Chat Cancel — Explicit Stop + Provider Timeout Safety Net

**Date:** 2026-09-21
**Status:** Draft
**Related:** [Issue #196](https://github.com/tkottke90/amazing-hashbrown/issues/196)

---

## Problem

Every SSE-driven chat turn (global chat, workspace chat, wiki chat) registers itself in an
in-memory per-thread mutex before it starts (`setActiveSseWriter(threadId, sink)` in
`api/src/agents/active-sse-writer.ts`) and clears it in a `finally` block once the turn ends.
A second request against the same thread while that mutex is held is rejected with
`stream_error: "This workspace has a task running — try again in a moment."`

Nothing frees that mutex if the client's turn is abandoned. None of the nine interactive SSE
handler functions — `stream`/`resume`/`retry` across `stream-handler.ts` (global chat),
`workspace-chat-stream-handler.ts`, and `wiki-stream-handler.ts` — ever pass a `signal` into
`agent.streamEvents()`, and the UI's own `stopGeneration()` (`ui/src/hooks/use-thread.ts`) only
aborts the browser's local `fetch` — it never tells the server. So a turn that outlives its
client (closed tab, lost network, or even a deliberate click of the existing "Stop" button) keeps
running server-side to completion regardless, holding the mutex the entire time. Any later
message, retry, or automated task run against that thread is rejected until the orphaned call
eventually finishes — which today has no upper bound at all, since `provider-factory.ts` sets no
request timeout on any LLM client.

This mirrors a gap already called out in `docs/superpowers/specs/2026-08-29-task-cancel-abort-design.md`
(#86), which fixed the equivalent problem for automated task runs but explicitly scoped itself to
tasks only, leaving interactive chat's version of the same bug for later. This is that later.

### Why not just abort on client disconnect?

The obvious fix — listen for `res.on('close')` and abort immediately — was considered and
rejected. A server can't distinguish "the user clicked Stop," "the tab was closed," and "a mobile
OS suspended the tab's background network activity because the screen locked" — all three look
identical as a `close` event. Mobile browsers (iOS Safari especially) can tear down a backgrounded
tab's network connections well before the user has any intention of abandoning the turn. Tying
cancellation to disconnection would silently kill legitimate long-running turns the moment someone
puts their phone in their pocket. This design decouples cancellation from disconnection entirely:
a turn only ever stops because something explicitly asked it to, or because a bounded provider
timeout fired.

---

## Non-goals

- Reconnecting to or resuming a still-running turn after a dropped connection. A disconnected
  client simply stops receiving live SSE events; the turn keeps running server-side and its result
  is available on the next thread reload, same as today for any turn a tab was closed during.
- Any change to automated task cancellation (`#86`, `active-task-abort.ts`) — that system is
  untouched. A thread currently owned by a task run (no `AbortController` registered by this
  design) correctly 409s the new Stop route rather than reaching into the task's own controller.
- A precise, tuned default for the new provider `timeoutMs`, or solving Ollama's timeout plumbing
  specifically (its client doesn't expose the same constructor option `ChatOpenAI`/`ChatAnthropic`
  do) — left as an implementation-time decision.
- Pause/take-over semantics for chat turns. A chat turn is either running or it's over; there's no
  queue row to park it in, unlike an automated task.

---

## Design

### 1. Abort registry — extend `active-sse-writer.ts`

`getActiveSseWriter`/`setActiveSseWriter`/`clearActiveSseWriter` keep their existing signatures
and behavior for every current caller (9 call sites across tool files, `task-execution.ts`,
`headless-turn.ts`, `pending-thread-turns.ts` — none of them change). A second, parallel map is
added to the same module, keyed the same way as the existing writer map:

```ts
const _controllers = new Map<string, AbortController>();

export function setActiveSseWriter(threadId: string, writer: SseWriter, controller?: AbortController): void {
  _writers.set(threadId, writer);
  if (controller) _controllers.set(threadId, controller);
}

export function getActiveTurnAbort(threadId: string): AbortController | undefined {
  return _controllers.get(threadId);
}

export function clearActiveSseWriter(threadId: string): void {
  _writers.delete(threadId);
  _controllers.delete(threadId);
}
```

`controller` is optional so `task-execution.ts` (which manages its own separate registry,
`active-task-abort.ts`, for pause/take-over/cancel) never needs to change — it simply never passes
one, and `getActiveTurnAbort` correctly returns `undefined` for a task-owned thread.

### 2. Per-handler wiring

Each of the 9 interactive handler functions (`stream`/`resume`/`retry` × global chat/workspace
chat/wiki chat) gets the same three additions at its existing `setActiveSseWriter` call site:

1. `const controller = new AbortController();` at the top of the function.
2. `setActiveSseWriter(threadId, sink, controller);`
3. `signal: controller.signal` threaded into both `getProviderQueue().withSlot(..., { onWaitChange, signal: controller.signal })` — `provider-queue.ts`'s `acquireSlot` already accepts and wires up `signal` (it cancels a queued wait for a provider concurrency slot), it's just never passed from these call sites today — and into `agent.streamEvents(input, { ..., signal: controller.signal })`, the same field `task-execution.ts` already uses.

No `req.on('close')` listener is added anywhere. A disconnect alone never touches the controller.

### 3. Stop route

One new route per chat surface, matching the existing `/:threadId/retry` pattern:

- `POST /api/v1/chat/:threadId/stop` (`chat.route.ts`)
- `POST /api/v1/workspaces/:id/chat/:threadId/stop` (`workspace-chat.route.ts`)
- `POST /api/v1/wiki/chat/:threadId/stop` (`wiki.route.ts`)

```ts
const controller = getActiveTurnAbort(threadId);
if (!controller) {
  res.status(409).json({ error: 'No active turn for this thread' });
  return;
}
controller.abort();
res.status(202).json({ ok: true });
```

The route doesn't wait for the original turn to unwind — that happens asynchronously inside the
original request, exactly as it already does for any other error today.

### 4. Persisting a stopped turn

When `controller.abort()` fires, the in-flight call throws — either `agent.streamEvents()`'s own
abort error, or (if the turn was still queued waiting on a provider concurrency slot)
`provider-queue.ts`'s `"Aborted while waiting for provider ... capacity"` error. Rather than
pattern-matching the thrown error's shape (different providers throw differently-shaped abort
errors), each handler's existing catch block checks `controller.signal.aborted` directly — the
same technique `task-execution.ts`'s catch block already uses via
`getTaskAbort(entry.id)?.controller.signal.aborted`:

```ts
} catch (err) {
  const { segmentId, content: partialContent, thoughtContent: partialThought } =
    extractPartialAssistantState(err, msgId);

  if (controller.signal.aborted) {
    failAssistant(threadStore, threadId, segmentId, partialContent, turnSentAt, partialThought,
      'Stopped.', 'cancelled');
    return; // not rethrown — this isn't a failure
  }

  // ...unchanged genuine-error path (GraphRecursionError, classifyChatError, etc.)
}
```

This needs one new value on the shared `ChatErrorCategory` enum
(`lib/llm-common-types/src/chat/sse-events.ts`): `'cancelled'`. It's consumed exactly like every
other category already is — `ui/src/components/chat-error-detail.tsx`'s `CATEGORY_INFO` record
(a `Record<ChatErrorCategory, ...>`, so TypeScript forces this to be filled in) gains an entry
with neutral, non-alarming copy ("Stopped before finishing") and icon, since this isn't a failure,
it's what the user asked for. Whatever content/tool calls had already streamed stays on the
bubble — this is the existing `failAssistant` behavior, unchanged.

As a side effect, this also fixes a related latent bug: today, a tab closed mid-turn (before any
abort ever fires) leaves that turn's `thread_messages` row stuck at `status: 'streaming'`
forever, since nothing ever calls `finalizeAssistant`/`failAssistant` for it. With the Stop route
in place, any turn a user deliberately stops now always reaches a terminal persisted state.

### 5. UI wiring

`stopGeneration()` (`ui/src/hooks/use-thread.ts`) gets one addition: alongside its existing
`_abortController?.abort()` (which still gives instant local UI feedback, unchanged), it fires a
best-effort, un-awaited `fetch(\`${endpointBase}/${threadId}/stop\`, { method: 'POST' })` and
swallows any error. Nothing else about the function changes.

### 6. Provider request timeout (safety net)

For the case where no one ever clicks Stop and the client is genuinely gone for good — `ProviderSchema`
(`api/src/config/env.ts`) gains an optional `timeoutMs: z.number().int().optional()`, following the
same pattern as the existing `maxConcurrency` field. `provider-factory.ts`'s
`createProviderFromConfig` passes it into each SDK's own `timeout` constructor option
(`ChatOpenAI`, `ChatAnthropic` both accept this natively; Ollama's client plumbing is an
implementation-time detail per the Non-goals above). This bounds a single hung provider HTTP
call — not a whole multi-tool-call agent turn, which legitimately makes many bounded calls in
sequence and should be allowed to keep going. Once a call times out, it throws like any other
provider error, hits the existing unchanged genuine-failure path, and the `finally` block clears
the mutex exactly as it does for any other error today.

---

## Error handling

| Case | Behavior |
| --- | --- |
| Stop arrives after the turn already finished naturally | Registry entry is already cleared → 409, harmless |
| Stop clicked twice | Second call either 409s (already cleared) or calls `.abort()` on an already-aborted controller — a no-op |
| Stop hits a thread currently owned by an automated task run | `task-execution.ts` never registers a controller here, so `getActiveTurnAbort` returns `undefined` → 409. Task cancellation stays exclusively `#86`'s `/tasks/:id/cancel` route |
| Provider call hangs indefinitely, client never disconnects or clicks Stop | Bounded by the new `timeoutMs` safety net, not by this design's cancel path |

---

## Testing

Following this repo's conventions (Mocha/Chai, `[unit]`/`[orchestration]` tags, real fakes not
mocks, per `AGENTS.md`):

- `active-sse-writer.test.ts`: `setActiveSseWriter`/`getActiveTurnAbort`/`clearActiveSseWriter`
  round-trip; omitting `controller` leaves `getActiveTurnAbort` `undefined` (regression guard —
  `task-execution.ts`'s existing behavior must stay unaffected).
- Each route file (`chat.route.test.ts`, `workspace-chat.route.test.ts`, `wiki.route.test.ts` or
  equivalent): `/stop` → 409 with nothing active; 409 against a task-owned entry (writer set, no
  controller); 202 + `signal.aborted` true against a chat-owned entry.
- Each of the 9 handler functions: inject a fake `streamEvents` that throws once the passed
  `signal` is aborted (same fake-stream technique `task-execution.test.ts` already uses) — asserts
  `failAssistant` is called with `errorCategory: 'cancelled'`, the function returns without
  rethrowing, and `clearActiveSseWriter` still runs in `finally` (the mutex actually frees — this
  is the direct regression test for issue #196's reported symptom).
- `provider-factory.test.ts`: `timeoutMs` is passed through to the underlying SDK constructor
  call when present, omitted when not.
- E2E (Playwright, mocked SSE responses per `e2e/AGENTS.md`'s pattern): start a turn, click Stop,
  assert the bubble reaches a terminal "Stopped" state, then assert a new message can be sent on
  the same thread immediately afterward — proving the mutex actually released.

This is not an LLM-behavior change (no prompt or model-output semantics shift), so EDD's
failing-eval-first requirement doesn't apply — this is plumbing, covered by the developer and E2E
tests above.
