# HITL Recovery on Reconnect — Design

**Date:** 2026-08-06
**Status:** Draft
**Depends on:** Shell Execution Integration

---

## Goal

Ensure that a pending HITL (Human-in-the-Loop) prompt — a shell approval or an `ask_user` interrupt — is always recoverable after a page reload or server restart, and that the shell approval prompt renders identically on hydration as it does in the live SSE flow.

---

## Problem

Two related gaps exist in the current HITL persistence path.

**Gap 1 — Silent write failure.** `recordHitlPrompt()` and `resolveHitlPrompt()` in `thread-message-writer.ts` are wrapped in `safe()`, a helper that catches all errors, logs them, and returns `null`. This is correct for observability-only writes (tool call records, assistant content) where a DB failure should not kill the live turn. It is incorrect for HITL writes: if `recordHitlPrompt()` silently fails, the LangGraph checkpoint holds the interrupt state but `thread_messages` has no row. On reload, `hydrateThread()` finds nothing and the thread appears stuck with no way to resume. Similarly, if `resolveHitlPrompt()` silently fails, the row stays `pending` forever even after the graph has moved on, causing every subsequent reload to show a ghost HITL prompt.

**Gap 2 — Missing fields on hydration.** `HitlPromptFields` (the shape persisted to `thread_messages`) does not include `command` or `reason` for `shell_approval`. On a live SSE stream, the frontend receives these fields in the `hitl_prompt` SSE event and renders proper Approve / Approve & remember / Deny buttons. On hydration from `GET /threads/:id`, those fields are absent, so the shell approval falls through to the `free_text` rendering branch and shows a plain text input instead.

---

## Non-goals

- A new `GET /threads/:id/status` endpoint querying the LangGraph checkpoint directly. The existing `hydrateThread()` + `thread_messages` path handles all realistic recovery scenarios once the write is made durable.
- Auto-reconnect or SSE retry logic. Mid-stream disconnects already surface as `stream_error` with a retry button.
- E2e coverage for `multiple_choice` HITL type (separate gap, out of scope here).

---

## Design

### 1. Make HITL writes durable (`thread-message-writer.ts`)

Remove `safe()` from `recordHitlPrompt()` and `resolveHitlPrompt()`. Both functions throw on DB failure instead of swallowing it.

`recordHitlPrompt()` return type changes from `number | null` to `number` — a null return no longer makes sense when failure is an error.

`resolveHitlPrompt()` return type stays `void` but now throws instead of silently no-oping.

All other functions in the file remain `safe()`-wrapped; they are genuinely observability-only writes.

`HitlPromptFields` gains two optional fields, populated only for `shell_approval`:

```ts
export interface HitlPromptFields {
  question: string;
  promptKind: 'yes_no' | 'multiple_choice' | 'free_text' | 'shell_approval';
  choices?: string[];
  allowFreeText?: boolean;
  approveLabel?: string;
  approveType?: 'primary' | 'secondary' | 'destructive';
  rejectLabel?: string;
  command?: string; // shell_approval only
  reason?: string; // shell_approval only
}
```

### 2. Handle write failures in `stream-handler.ts`

**`finalizeTurn()`** — wraps the `recordHitlPrompt()` call in a try/catch. The `hitl_prompt` SSE event is emitted only after the write succeeds. On failure, `failAssistant()` is called and a `stream_error` event is emitted. The interrupt payload for `shell_approval` (`{ kind, command, reason }`) is already available from `state.tasks[0].interrupts[0]`; `command` and `reason` are passed through into `HitlPromptFields`.

```
try {
  const seq = recordHitlPrompt(store, threadId, promptId, fields)
  writeSseEvent(res, { type: 'hitl_prompt', promptId, seq, ...fields })
} catch (err) {
  logger.error('finalizeTurn: failed to persist HITL prompt', { threadId, err })
  failAssistant(store, threadId, assistantId, partialContent, sentAt)
  writeSseEvent(res, { type: 'stream_error', message: 'Failed to save approval prompt' })
}
```

**`resumeChatToSse()`** — wraps the `resolveHitlPrompt()` call in a try/catch. On failure, a `stream_error` event is emitted and the LangGraph resumption is skipped. The HITL row remains `pending` in the DB, which is correct: the graph was not resumed, so the interrupt is genuinely still live and the user can retry.

### 3. Fix shell approval rendering on hydration

**`lib/llm-common-types/src/chat/hitl.ts`** — verify `command` and `reason` are present on the shared HITL type; add them if missing.

**`ui/src/types/thread-message.ts`** — the `hitl_prompt` message shape gains `command?: string` and `reason?: string`.

**`ui/src/components/hitl-prompt-message.tsx`** — add an explicit `shell_approval` branch before the existing `free_text` else-fallthrough. The branch renders:

- A `<code>` block displaying the `command`
- The `reason` as plain text
- Three buttons: Approve (`'approved'`), Approve & remember (`'approved_remember'`), Deny (`'denied'`)

`submitHitlAnswer()` already handles all three answer strings; no changes needed in the submission path.

No changes to `hydrateThread()` or the SSE client are required. The existing detection logic (`last.kind === 'hitl_prompt' && last.status === 'pending'`) already works correctly once `command` and `reason` are in the persisted payload.

---

## Data flow after this change

**Live turn (no change to happy path):**

1. Agent hits `interrupt({ kind: 'shell_approval', command, reason })`
2. `finalizeTurn()` reads interrupt from checkpoint
3. `recordHitlPrompt()` writes to DB — **throws on failure**
4. `hitl_prompt` SSE event emitted (only reaches here if step 3 succeeded)
5. Frontend renders Approve/Deny buttons

**Reload / server restart:**

1. `hydrateThread()` fetches `GET /threads/:id`
2. Last message: `{ kind: 'hitl_prompt', status: 'pending', promptKind: 'shell_approval', command, reason, question }`
3. `pendingHitlId` set; `HitlPromptMessage` renders Approve/Deny buttons — **identical to live flow**

**Write failure during turn:**

1. `recordHitlPrompt()` throws
2. `finalizeTurn()` catch: `failAssistant()` marks assistant row as error, emits `stream_error`
3. User sees turn error with retry button — no ghost pending HITL state

**HITL answer submission failure:**

1. `resolveHitlPrompt()` throws
2. `resumeChatToSse()` catch: emits `stream_error`
3. HITL row stays `pending`; user can resubmit their answer

---

## Testing

### Unit tests (`api/test/`)

- `thread-message-writer`: `recordHitlPrompt` throws when `store.insertMessage` throws (replaces the existing null-return assertion); `command` and `reason` are present in the persisted payload for `shell_approval`; `resolveHitlPrompt` throws when `store.updateMessage` throws.
- `stream-handler`: `finalizeTurn()` emits `stream_error` and calls `failAssistant()` when `recordHitlPrompt` throws, and does not emit `hitl_prompt`; `resumeChatToSse()` emits `stream_error` and skips graph resumption when `resolveHitlPrompt` throws.

### E2e (`e2e/tests/`)

New spec `hitl-shell-approval.spec.ts` tagged `@smoke @user-workflow` (no `@llm` needed — mocked API):

1. Mock `GET /api/v1/threads/:id` to return a thread whose last message is a pending `shell_approval` HITL prompt with `command: 'ls -la'` and `reason: 'List directory contents'`
2. Load the thread URL
3. Assert Approve, Approve & remember, and Deny buttons are visible; assert text input is not visible
4. Mock `POST /api/v1/chat/:threadId/hitl` to return a stream that completes successfully
5. Click Approve; assert the chat input re-enables

---

## Files changed

| File                                            | Change                                                                                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/src/agents/thread-message-writer.ts`       | Remove `safe()` from `recordHitlPrompt` and `resolveHitlPrompt`; add `command?`/`reason?` to `HitlPromptFields`                                                        |
| `api/src/agents/stream-handler.ts`              | Wrap `recordHitlPrompt()` in try/catch in `finalizeTurn()`; pass `command`/`reason` for shell approval; wrap `resolveHitlPrompt()` in try/catch in `resumeChatToSse()` |
| `lib/llm-common-types/src/chat/hitl.ts`         | Add `command?` and `reason?` to shared HITL type if absent                                                                                                             |
| `ui/src/types/thread-message.ts`                | Add `command?` and `reason?` to `hitl_prompt` message shape                                                                                                            |
| `ui/src/components/hitl-prompt-message.tsx`     | Add `shell_approval` rendering branch with Approve/Deny buttons                                                                                                        |
| `api/test/agents/thread-message-writer.test.ts` | Update/add unit tests per above                                                                                                                                        |
| `api/test/agents/stream-handler.test.ts`        | Add unit tests per above                                                                                                                                               |
| `e2e/tests/hitl-shell-approval.spec.ts`         | New e2e spec per above                                                                                                                                                 |
