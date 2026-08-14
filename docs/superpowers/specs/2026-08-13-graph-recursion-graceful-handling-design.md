# Graph Recursion Graceful Handling — Design

**Date:** 2026-08-13
**Status:** Draft
**Related:** [Issue #59](https://github.com/tkottke90/amazing-hashbrown/issues/59)

---

## Goal

When the wiki or chat agent approaches LangGraph's recursion limit, the system should pause gracefully, tell the user what has been happening, and offer a way to continue — rather than silently killing the stream and leaving the chat in a frozen spinner state.

---

## Problem

When the agent exhausts LangGraph's recursion limit (currently hardcoded at 100 steps in four places), a `GraphRecursionError` is thrown. The catch in `pipeEvents` calls `failAssistant()` and re-throws. The route layer logs it and emits a raw `{ type: 'stream_error' }` SSE event to the client. The UI receives this and... does nothing visible. The spinner never resolves and the chat input stays locked. There is no way to know what the agent attempted or how to unblock the session.

Three things are wrong simultaneously:

1. **Silent failure** — the error is never surfaced as a user-visible message
2. **No observability** — the user has no idea what the agent was doing
3. **No recovery path** — even if they knew what happened, there is nothing to do

The recursion limit being hit is a symptom of real-world agent behavior (complex wiki operations, tool chains that require many steps). The fix is to build the system to be resilient — not to restrict what the agent can do or chase individual loop edge cases.

---

## Non-goals

- Fixing the specific `wiki_create_page` false-positive duplicate logic that triggered the original bug report. That is a separate issue.
- A streaming step counter visible in the UI (progress bar, step counter widget). The HITL prompt is the notification.
- Silently bumping the recursion limit and retrying without user awareness.

---

## Key Design Insight: Interrupt Before Death

LangGraph's HITL `interrupt()` mechanism suspends the graph while it is still alive — the checkpoint is written and `Command({ resume: answer })` can pick up exactly where the graph left off, with a fresh recursion budget for the new invocation.

A `GraphRecursionError`, by contrast, kills the graph. There is no active pause point to resume into; the checkpoint is at the dead step. Retrying from that checkpoint with the same limit immediately fails again.

The correct approach is therefore to intercept **before** the limit is reached — while the graph is still healthy — and use `interrupt()` to pause it gracefully. This converts "dead graph with no recovery path" into "paused graph with a HITL prompt the user can respond to."

---

## Design

### 1. Make the recursion limit configurable

The recursion limit is currently hardcoded at `100` in four places with a `// TODO: Make this a configurable option` comment already present. Move it to config.

**`config.yaml` / `AppConfigSchema`:**

```yaml
agent:
  recursionLimit: 100 # max steps per invocation
  recursionWarnThreshold: 0.75 # fraction of limit at which to interrupt
```

```typescript
agent: z.object({
  recursionLimit: z.number().int().positive().default(100),
  recursionWarnThreshold: z.number().min(0.1).max(0.99).default(0.75),
}).optional(),
```

The four hardcoded `recursionLimit: 100` values in `stream-handler.ts` (line 449) and `wiki-stream-handler.ts` (lines 67, 153, 239) are replaced with `env.agent?.recursionLimit ?? 100`.

### 2. Add `recursionGuardMiddleware`

A new `beforeAgent` middleware added to both the chat and wiki ingestion agents. It fires before each LLM call and tracks how many LLM calls have occurred in the current invocation. When the count crosses the configured threshold, it calls `interrupt()` with a structured HITL payload.

```typescript
// api/src/agents/recursion-guard.middleware.ts

export function createRecursionGuardMiddleware(recursionLimit: number, warnThreshold: number) {
  return createMiddleware({
    name: 'RecursionGuardMiddleware',
    beforeAgent: async (state) => {
      const step = getInvocationStep(); // see implementation note below
      const threshold = Math.floor(recursionLimit * warnThreshold);

      if (step >= threshold) {
        interrupt({
          kind: 'recursion_limit_warning',
          question:
            'I have been working for a while and want to check in before continuing. What would you like me to do?',
          stepsUsed: step,
          recursionLimit,
          kind: 'multiple_choice',
          choices: ['Continue working', 'Stop and summarize what you have done so far'],
          allowFreeText: true,
        });
      }

      return undefined;
    },
  });
}
```

**Implementation note — step counting:** The `beforeAgent` hook signature exposes `state` (messages). Whether it also exposes the LangGraph invocation config (which carries `metadata.langgraph_step`) must be verified at implementation time against the `langchain` 1.5.2 `createMiddleware` API.

Two fallback strategies if `langgraph_step` is not in scope:

- **Option A — external per-invocation counter:** maintain a `Map<threadId, number>` keyed by thread ID that is incremented each time `beforeAgent` fires and cleared at the end of each `streamEvents` call (in the `finally` block of `streamChatToSse` / `streamWikiChatToSse`). This is a count of LLM calls, not total LangGraph steps — slightly under-counts tool execution steps, but is a reliable proxy.
- **Option B — read from state metadata:** if LangGraph embeds the step count in the graph state itself (not config metadata), it may be readable as `state.metadata?.langgraph_step`.

The implementation should prefer exact step count if available and fall back to the LLM-call counter.

**Idempotency:** `interrupt()` causes LangGraph to re-run the entire node from the top on resume. The middleware must therefore not have side effects before the `interrupt()` call — logging and reading state are fine; writing to any store is not.

### 3. Handle the interrupt in `finalizeTurn`

The `recursion_limit_warning` kind is a new HITL prompt kind. `finalizeTurn()` already reads `state.tasks[0].interrupts[0]` to detect HITL interrupts. It needs a new branch:

```typescript
if (interrupt.value.kind === 'recursion_limit_warning') {
  const fields: HitlPromptFields = {
    question: interrupt.value.question,
    promptKind: 'multiple_choice',
    choices: interrupt.value.choices,
    allowFreeText: true,
    // surfaced metadata for the user-facing message
    stepsUsed: interrupt.value.stepsUsed,
    recursionLimit: interrupt.value.recursionLimit,
  };
  const seq = recordHitlPrompt(store, threadId, promptId, fields);
  writeSseEvent(res, { type: 'hitl_prompt', promptId, seq, ...fields });
}
```

The frontend renders this as a `multiple_choice` HITL prompt. No new UI component is needed — `hitl-prompt-message.tsx` already handles `multiple_choice` with `allowFreeText`. The `stepsUsed` / `recursionLimit` metadata can be surfaced as a subheading ("I've taken 76 steps so far out of a limit of 100.") inside the existing component.

### 4. Handle the user's response in `resumeChatToSse` / `resumeWikiChatToSse`

The answer from the HITL prompt flows back through the existing resume path via `Command({ resume: answer })`. The agent receives the answer as the return value of `interrupt()` inside the middleware, which means on resume the middleware's `beforeAgent` fires again, gets the answer, and returns normally — the graph then proceeds to the LLM with the user's guidance prepended to context.

**Agent behavior:** the answer string ("Continue working", "Stop and summarize…", or a free-text instruction) is returned from `interrupt()`. The middleware returns it to the LangGraph runtime as the resumed value. The LLM then sees the user's guidance as context for its next action. No special routing in the middleware is needed — the LLM decides what to do based on the answer.

### 5. Fix missing `recursionLimit` on resume calls

`resumeChatToSse()` and `resumeWikiChatToSse()` currently do not pass `recursionLimit` to `agent.streamEvents()`. This means a HITL resume runs under LangGraph's default limit (25 steps), not the configured limit. All resume calls must pass the configured limit:

```typescript
agent.streamEvents(new Command({ resume: answer }), {
  ...config,
  version: 'v2',
  recursionLimit: env.agent?.recursionLimit ?? 100, // add this
  callbacks: [obsHandler],
  // ...
});
```

This applies to `resumeChatToSse` in `stream-handler.ts` and `resumeWikiChatToSse` in `wiki-stream-handler.ts`.

### 6. Catch dead-graph as a hard fallback

The proactive interrupt should prevent `GraphRecursionError` from ever being thrown in practice. However, the error catch in both stream handlers should still be improved as a fallback — in case the limit is hit before the first `beforeAgent` fires, or the limit was configured lower than the threshold.

Currently the error is caught and re-thrown with no special handling. The route layer emits a raw `stream_error` that the UI silently ignores. Instead:

```typescript
} catch (err) {
  if (err instanceof GraphRecursionError || err?.name === 'GraphRecursionError') {
    // Emit a visible assistant message so the UI is never left frozen
    const summary = buildRecursionErrorMessage(threadId, err);
    writeAssistantMessage(threadStore, threadId, msgId, summary, turnSentAt);
    writeSseEvent(res, { type: 'assistant_message', content: summary });
    writeSseEvent(res, { type: 'stream_end' });
    return; // do not re-throw; the stream ends cleanly
  }
  failAssistant(threadStore, threadId, msgId, '', turnSentAt);
  throw err;
}
```

`buildRecursionErrorMessage()` is a pure function that returns a fixed string like:

> "I ran out of steps before finishing. You can reply with instructions to continue, or ask me to summarize what I accomplished so far."

This message is written to `thread_messages` so it appears on reload. No LLM call is needed — the message is static. This is intentional: attempting an LLM call during error recovery is risky (the model may have been the source of the loop), and a clear static message is more reliable than a generated summary at this point.

---

## Data Flow

**Happy path (completes under threshold):**

No change. The middleware fires before each LLM call, checks the step count, finds it below threshold, and returns `undefined`.

**Agent approaches threshold:**

1. `beforeAgent` fires, step count ≥ threshold
2. `interrupt({ kind: 'recursion_limit_warning', ... })` is called — graph suspends
3. `finalizeTurn()` detects the interrupt, writes `hitl_prompt` row to DB, emits `hitl_prompt` SSE
4. UI renders the HITL prompt: "I've been working for a while. Continue working? Stop and summarize? Or give me specific instructions..."
5. User answers → `POST /chat/:threadId/hitl` → `resumeChatToSse()`
6. `Command({ resume: answer })` resumes the graph from the checkpoint with a fresh recursion budget
7. Agent proceeds with user guidance; middleware step counter resets for the new invocation

**Dead-graph fallback (middleware didn't fire in time):**

1. `GraphRecursionError` thrown inside `pipeEvents`
2. Catch branch identifies the error type
3. Static "ran out of steps" message written to DB and emitted as `assistant_message` SSE
4. Stream ends cleanly (`stream_end` emitted); UI unlocks
5. User can reply with instructions to continue as a normal new turn

---

## `HitlPromptFields` additions

```typescript
export interface HitlPromptFields {
  question: string;
  promptKind:
    'yes_no' | 'multiple_choice' | 'free_text' | 'shell_approval' | 'recursion_limit_warning';
  choices?: string[];
  allowFreeText?: boolean;
  approveLabel?: string;
  approveType?: 'primary' | 'secondary' | 'destructive';
  rejectLabel?: string;
  command?: string; // shell_approval only
  reason?: string; // shell_approval only
  stepsUsed?: number; // recursion_limit_warning only
  recursionLimit?: number; // recursion_limit_warning only
}
```

---

## Testing

### Unit tests (`api/src/agents/`)

**`recursion-guard.middleware.test.ts`:**

- Does not call `interrupt()` when step count is below threshold
- Calls `interrupt()` with correct payload when step count equals threshold
- Calls `interrupt()` when step count exceeds threshold
- Returns `undefined` (no state mutation) when below threshold

**`stream-handler.test.ts` additions:**

- `GraphRecursionError` catch emits `assistant_message` and `stream_end`, does not re-throw
- Other errors still re-throw (existing behavior preserved)
- Resume calls include `recursionLimit` in the config

### Integration tests (`api/src/agents/`)

Extend the existing scripted-model integration tests (`thread-fork.test.ts` pattern) to drive a graph that hits the threshold — verify the interrupt fires, the HITL prompt is written to `thread_messages`, and a resume with `"Continue working"` proceeds past the checkpoint.

### E2e (`e2e/tests/`)

New spec `recursion-guard.spec.ts` tagged `@smoke @user-workflow` (mocked API, no `@llm`):

1. Mock a thread whose last message is a pending `recursion_limit_warning` HITL prompt
2. Assert the UI renders: step count info, "Continue working" and "Stop and summarize" buttons, free-text input
3. Click "Continue working" → assert the chat input is re-enabled (stream completes)
4. Separately: mock the `GraphRecursionError` fallback path, assert the static message appears and the chat input unlocks

---

## Files Changed

| File                                                | Change                                                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `api/src/config/env.ts` / `AppConfigSchema`         | Add `agent.recursionLimit` and `agent.recursionWarnThreshold` config fields                                          |
| `api/src/agents/recursion-guard.middleware.ts`      | New file — `createRecursionGuardMiddleware()`                                                                        |
| `api/src/agents/chat-agent.ts`                      | Register `recursionGuardMiddleware`; replace hardcoded `100` in `streamChatToSse`                                    |
| `api/src/agents/wiki-ingestion-agent.ts`            | Register `recursionGuardMiddleware`                                                                                  |
| `api/src/agents/stream-handler.ts`                  | Replace hardcoded `recursionLimit: 100`; add `recursionLimit` to resume call; add `GraphRecursionError` catch branch |
| `api/src/agents/wiki-stream-handler.ts`             | Same as `stream-handler.ts` — three hardcoded values + three resume calls                                            |
| `api/src/agents/thread-message-writer.ts`           | Add `stepsUsed?` and `recursionLimit?` to `HitlPromptFields`; add `'recursion_limit_warning'` to `promptKind` union  |
| `lib/llm-common-types/src/chat/hitl.ts`             | Same `HitlPromptFields` additions on the shared type                                                                 |
| `ui/src/components/hitl-prompt-message.tsx`         | Surface `stepsUsed`/`recursionLimit` metadata as subheading for `recursion_limit_warning` kind                       |
| `api/src/agents/recursion-guard.middleware.test.ts` | New unit tests                                                                                                       |
| `api/src/agents/stream-handler.test.ts`             | New tests for error catch branch and resume `recursionLimit`                                                         |
| `e2e/tests/recursion-guard.spec.ts`                 | New e2e spec                                                                                                         |
