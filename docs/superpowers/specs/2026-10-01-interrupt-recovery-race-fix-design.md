# Interrupt Recovery Race Fix — Design

**Date:** 2026-10-01
**Status:** Approved — not yet implemented
**Related:** [Issue #72](https://github.com/tkottke90/amazing-hashbrown/issues/72) (Cron Task Triggers), [Issue #240](https://github.com/tkottke90/amazing-hashbrown/issues/240) (the sibling gap this surfaced alongside)

---

## Goal

A task whose first-ever turn hits a `shell_exec` approval gate must reliably land in `waiting_on_user`. Today it sometimes lands in `failed` instead, silently losing the approval prompt, because `recoverThrownInterrupt()` re-derives a value it already has in hand, through a path that can race.

---

## Problem

`recoverThrownInterrupt()` (`api/src/agents/stream-handler.ts:495-...`) recovers a `GraphInterrupt` thrown mid-stream by LangGraph's `interrupt()` call (used by `shell_exec`'s approval gate, among others). After catching it, it does:

```ts
const state = await agent.graph.getState(config);
const interrupt = state.tasks?.[0]?.interrupts?.[0];
```

— re-querying checkpoint state to find the interrupt value. On a brand-new checkpoint (a task's first-ever turn on a freshly-minted thread), this read can come back empty even though the interrupt genuinely happened, and the run is reported as a failure instead of a pause. (Diagnosed and given a specific, logged failure reason — `no_interrupt_in_state` — in a prior change; this spec fixes the underlying cause rather than just naming it.)

The `getState()` call is unnecessary. `@langchain/langgraph`'s `interrupt()` (`dist/interrupt.js`) throws:

```js
throw new GraphInterrupt([{ id: ..., value }]);
```

and `GraphInterrupt` (`dist/errors.js`) has a public `.interrupts` field populated directly from that argument — the exact value `recoverThrownInterrupt` is trying to re-fetch is already sitting on the error it caught. Confirmed `getState()` serves no other purpose in this function: it always passes `checkpointId: null` downstream (unlike the graceful, non-thrown interrupt path in `finalizeTurn`, which has a legitimate `getState()` call for a real checkpoint id).

---

## Decisions

| Question                                                             | Decision                                                                                                                                                                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fix scope                                                              | **The shared `recoverThrownInterrupt()` function itself.** It's used by every turn type (chat, workspace chat, wiki chat, headless notifications, task runs) — the race is structural to the function, not task-specific, so every caller gets fixed at once. |
| Keep `getState()` as a defensive fallback?                            | **No — remove it entirely.** The error's own `.interrupts` is the sole source of truth. If it's ever empty, that's a different, more clearly-anomalous failure, not something worth a checkpoint round-trip to double check. |
| Alternative: retry `getState()` after a delay                         | **Rejected.** A band-aid, not a fix — adds latency to every interrupt, and is inherently non-deterministic to test. We have a real root-cause fix available. |
| Alternative: never let interrupts throw mid-stream (always graceful)  | **Rejected.** Much larger blast radius (how `pipeEvents` consumes every turn's event stream), higher risk, and LangGraph's own design indicates this throw path isn't fully avoidable from our side. |

---

## Design

### 1. Data flow

```
interrupt() throws GraphInterrupt([{ id, value }])
  → pipeEvents' catch wraps it: PipeEventsError(sourceErr, segmentId, partialContent, partialThought)
      (PipeEventsError.name copies sourceErr.name, so `.name === 'GraphInterrupt'` still holds;
       PipeEventsError.sourceError holds the original, untouched)
  → recoverThrownInterrupt(err, ...) unwraps to the real GraphInterrupt and reads `.interrupts[0]`
  → that value is passed straight into dispatchHitlPrompt(..., interrupt, ...) as today
```

No change to anything downstream of extraction: `dispatchHitlPrompt` still persists the `hitl_prompt` row, still emits the SSE event, still returns the `{ interrupted, reason?, detail? }` shape from the prior diagnostics change.

### 2. New helper

A small helper mirroring this file's existing `extractPartialAssistantState` (same job — pull a specific field off a possibly-`PipeEventsError`-wrapped error):

```ts
function extractInterruptFromError(err: unknown): { value: unknown } | undefined {
  const source = err instanceof PipeEventsError ? err.sourceError : err;
  return (source as { interrupts?: { value: unknown }[] })?.interrupts?.[0];
}
```

Checking `err instanceof PipeEventsError` rather than assuming the wrapper is always present is cheap defensiveness in case a future call path reaches `recoverThrownInterrupt` without going through `pipeEvents`.

### 3. Signature change

`recoverThrownInterrupt` drops its `agent: AgentWithGraph` and `config` parameters — they existed only to make the `getState()` call:

```ts
// before
recoverThrownInterrupt(err, sink, threadStore, agent, config, threadId, msgId, turnSentAt, assistantSeq, userSeq, taskId?)
// after
recoverThrownInterrupt(err, sink, threadStore, threadId, msgId, turnSentAt, assistantSeq, userSeq, taskId?)
```

All 10 call sites get the same mechanical update (drop the two now-unused args), no other logic changes at any of them:

- `stream-handler.ts` (3 internal callers)
- `wiki-stream-handler.ts` (3)
- `workspace-chat-stream-handler.ts` (3)
- `headless-turn.ts` (1)
- `task-execution.ts` (1)

`AgentWithGraph` the interface stays — `finalizeTurn`'s own, legitimate `getState()` call (graceful path) still needs it.

### 4. The remaining failure mode

`reason: 'no_interrupt_in_state'` (and its board-summary text, and `task-execution.ts`'s invariant log) are unchanged in vocabulary — only *when* they fire changes: now it means "the caught error itself carried no interrupt value" (essentially never, barring a malformed error) rather than "the checkpoint didn't have it yet" (a routine timing problem). The log line in that branch updates its context from `{ threadId, tasks: state.tasks }` to `{ threadId, err: serializeError(err) }`, and its message text drops the now-inaccurate "checkpoint state" framing.

`dispatchHitlPrompt`'s other failure mode (`persist_failed` — the DB write itself throwing) is untouched; it's downstream of extraction and doesn't care where the value came from.

### 5. Testing

Every test that currently fakes the interrupt value via a `getState()`-returning stub instead bakes it onto the **thrown error**:

- `stream-handler.ts`'s `graphInterruptError(segmentId, content, thoughtContent?)` test helper gains an optional 4th param, `interruptValue?`, setting `.interrupts: interruptValue ? [{ value: interruptValue }] : []` on the constructed error.
- Tests that currently pass an interrupt value via `stubAgent({...})` switch to passing it through `graphInterruptError`'s new param instead; all calls to `recoverThrownInterrupt(...)` in this describe block drop the `agent`/`config` args.
- The safety-net test's assertions don't change (`reason === 'no_interrupt_in_state'`); its setup switches from `stubAgent(null)` to `graphInterruptError(..., undefined)`.
- The `persist_failed` test is unaffected in spirit — still needs a real interrupt value to reach `recordHitlPrompt`, now supplied the same new way.
- `stubAgent`/`TEST_CONFIG` remain in the file for `finalizeTurn`'s own tests (unaffected, still legitimately call `getState()`).
- `task-execution.ts`'s `fakeGraphInterruptAgent` gets the same treatment: its thrown error carries real `.interrupts`. The regression describe block's existing assertions (`waiting_on_user`, the persisted `hitl_prompt` row, the `no_interrupt_in_state`/`persist_failed` summary text) are unchanged — only how the value reaches `dispatchHitlPrompt` changes.

No new "simulate the race" test is needed or meaningfully possible — the fix removes the timing dependency rather than handling it, so there's nothing left to simulate.

---

## Non-goals

- Fixing `create_tasks`' inability to create cron-scheduled tasks (#240) — unrelated gap, tracked separately.
- The two `@local` e2e suites from the earlier diagnostics-only plan — still outstanding, deferred until this fix lands (they'll want to assert the *correct* `waiting_on_user` outcome, which this fix is what actually makes true).
- Any change to how LangGraph itself persists checkpoints or interrupts — this fix works entirely within what the thrown error already provides.
