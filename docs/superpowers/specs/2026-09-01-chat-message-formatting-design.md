# Chat Message Formatting — Design

**Date:** 2026-09-01
**Status:** Approved
**Issue:** [#65 — AI message display order incorrect when agent uses tools](https://github.com/tkottke90/amazing-hashbrown/issues/65)

---

## 1. Problem & Goal

Issue #65 reports that tool calls render after the assistant's full response text, rather than interleaved in the order they actually occurred — most visibly in the wiki chat. A codebase audit surfaced that this is not one bug but two, plus a related bug in how errored turns lose their content:

1. **Wiki chat's live rendering never got the ordering fix** that global chat and workspace chat already have, because it runs its own hand-duplicated state hook instead of the shared one.
2. **Every chat surface loses correct ordering on reload**, because the backend persists a turn's assistant text as a single row, overwritten wholesale at the end of the turn — so however correctly the frontend interleaves things live, a refresh always returns "assistant text, then all tool calls."
3. **When a turn errors, the UI discards any partial assistant content** it already streamed, showing only "Something went wrong. Please try again." The backend discards it too — `failAssistant` is called with a hardcoded empty string.

Goal: tool calls and assistant text render in the order they actually happened, live and after reload, on every chat surface — and an error mid-turn never erases work the user already saw happen.

---

## 2. Scope

**In scope:**
- Live and persisted chronological ordering of assistant text and tool calls, across all three chat surfaces.
- Preserving partial assistant content when a turn errors, both in the UI and in the database, with an inline error indicator instead of a full replacement.
- Making a failed-then-retried attempt visible (collapsed by default) instead of hidden once a retry supersedes it.
- Consolidating wiki chat onto the same `useThreadInstance()` hook used by global chat and workspace chat.

**Out of scope:**
- Tool-call card visual structure/content (`tool-call-message.tsx`) — confirmed correct as-is.
- Any other chat formatting issue not tied to ordering, error handling, or the wiki/shared-hook duplication — the audit found none beyond a duplicated `reorderMessagesForDisplay()` helper, which is resolved as a side effect of consolidation.

**Surfaces affected:**

| Surface | Page | Current state hook |
|---|---|---|
| Global chat | `ui/src/pages/chat/index.tsx` | `useThreadInstance()` |
| Workspace chat tab | `ui/src/pages/workspaces/workspace-chat-tab.tsx` | `useThreadInstance()` |
| Wiki ingestion chat | `ui/src/pages/wiki/ingestion-chat.tsx` | `use-wiki-ingestion.ts` (bespoke, to be removed) |

All three already render through the shared `ThreadMessageItem` (`ui/src/components/thread-message.tsx`); the divergence is entirely in state management upstream of that.

---

## 3. Root Causes

### 3a. Live ordering — wiki chat only

`ui/src/hooks/use-thread.ts` pushes a new array item for every `tool_call_start`/`tool_call_end`/etc., and tracks `_toolCallPendingSinceLastText`: if a tool call happened since the last text delta, the next `text_delta` opens a **new** assistant bubble (`isContinuation: true`) instead of merging backward into the pre-tool-call bubble. `chat/index.tsx` and `workspace-chat-tab.tsx` each additionally run a `reorderMessagesForDisplay()` pass to fix the case where the empty assistant placeholder created at turn start sorts ahead of a tool call that actually ran first.

`ui/src/pages/wiki/use-wiki-ingestion.ts` has near-identical `text_delta`/`thought_delta` handling but **no equivalent split logic** and **no reorder pass**. Its single assistant item, created once at turn start, keeps absorbing every later `text_delta` in place — always ahead of any tool call from that turn, regardless of when the text actually streamed.

### 3b. Persisted ordering — all surfaces

`api/src/agents/thread-message-writer.ts`: `recordAssistantStart` inserts one assistant row per turn, with its `seq` fixed before any tool call of that turn exists. `finalizeAssistant` later overwrites that row's `content` with the entire turn's concatenated text (built by `stream-handler.ts`'s `flushDelta`/`pipeEvents`, which appends every chunk into one string, blind to tool calls in between). Each tool call gets its own `seq` at the moment it starts — always after the assistant row's `seq`. `GET /threads/:id` orders by `seq`, so it always returns assistant-row-then-tool-calls, undoing whatever the live client correctly displayed.

### 3c. Error content loss

`ui/src/components/assistant-message.tsx`'s render logic is a ternary: streaming-with-no-content shows a loading state, `status === 'error'` shows "Something went wrong. Please try again.", otherwise renders `content`. The error branch wins over content even when `content` is non-empty. Server-side, all three stream handlers call `failAssistant(threadStore, threadId, msgId, '', turnSentAt)` with a hardcoded empty string on failure, discarding the partial text from persistence as well. `getThreadMessages` additionally filters out an errored row once a retry supersedes it, hiding the failed attempt entirely.

---

## 4. Fix Design

### 4a. Wiki chat consolidation

`ui/src/pages/wiki/use-wiki-ingestion.ts` is deleted. `useThreadInstance()` (`ui/src/hooks/use-thread.ts`) is extended to handle the SSE event kinds it doesn't currently switch on — `wiki_updated`, `wiki_oriented`, `wiki_domain_created` — mapping them to the existing `wiki_update` / `resource_card` `ThreadMessage` kinds already defined in `ui/src/types/thread-message.ts`. `ui/src/pages/wiki/ingestion-chat.tsx` is rewired to call `useThreadInstance()` against the `/api/v1/wiki/chat/:id` endpoint, following the same pattern `workspace-chat-tab.tsx` already uses for its own endpoint. `reorderMessagesForDisplay()` moves into the shared hook itself (currently duplicated between `chat/index.tsx` and `workspace-chat-tab.tsx`), so there is exactly one copy and wiki chat gets its benefit automatically.

This is the only change that prevents the bug class from recurring: a second hand-rolled reducer will eventually miss the next fix too, the same way it missed this one.

**Known risk:** `use-wiki-ingestion.ts` has not been read in full line-by-line as of this design (only summarized during the audit). It's possible it has a wiki-specific behavior not captured in that summary — e.g. different loading-state semantics or an optimistic-update path. This gets verified during implementation, not assumed away here.

### 4b. Persisted ordering — segment-based assistant rows

`thread-message-writer.ts` changes from "one assistant row per turn" to "one assistant row per text segment":

- `recordAssistantStart` opens segment 1, as today.
- On `tool_call_start`, if the currently-open assistant segment has accumulated content, finalize it now — write its content, freeze its `seq`.
- The next `text_delta` after that tool call opens a **new** assistant row, with `seq` assigned at that moment (landing after the tool call's `seq`, matching live-view ordering).
- `finalizeAssistant` at turn end finalizes whichever segment is currently open, rather than the whole turn.

`stream-handler.ts` (and the wiki/workspace equivalents)'s `flushDelta`/`pipeEvents` need the corresponding change: reset the text buffer at each tool-call boundary instead of concatenating the entire turn into one string.

Net effect: `GET /threads/:id` returns multiple assistant rows per turn when tool calls occurred, each correctly sequenced against its neighboring tool calls — reload matches live view.

### 4c. Error content preservation

**Rendering (`assistant-message.tsx`):** remove the branch that replaces content on `status === 'error'`. New logic: render `content` via `<Markdown>` whenever it's non-empty, and if `status === 'error'`, append a small inline indicator (e.g. "⚠ Response interrupted") after the content rather than instead of it. Only fall back to the plain error message when `content` is empty.

**Persistence:** every `failAssistant(threadStore, threadId, msgId, '', turnSentAt)` call site (`stream-handler.ts`, `wiki-stream-handler.ts`, `workspace-chat-stream-handler.ts`) passes the actual accumulated buffer at the point of failure instead of `''`, so partial content survives reload.

**Retry visibility:** remove the `getThreadMessages` filter that hides a `status: 'error'` row once a retry supersedes it. The frontend renders a superseded error row collapsed by default ("Attempt failed — click to view"), expandable to its partial content plus error indicator, with the successful retry rendered normally below it as the active turn. The existing `retryOf`-chained retry mechanism (`ui/src/hooks/use-thread.ts`'s `retryTurn`, `thread-message-writer.ts`'s `recordRetryAttempt`) is otherwise unchanged.

---

## 5. Testing Plan

- **Ordering (frontend):** a test on the shared hook's reducer asserting a `tool_call_start` received after `text_delta`s starts a new assistant message rather than merging into the prior one.
- **Ordering (backend):** a test on `thread-message-writer.ts` asserting a turn with text → tool call → text produces two assistant rows whose `seq` values correctly sandwich the tool call's `seq`.
- **Error preservation (frontend):** a test asserting `stream_error` leaves `content` intact and adds an error indicator rather than replacing the rendered output.
- **Error preservation (backend):** a test asserting `failAssistant` persists the accumulated buffer rather than `''`.
- **Retry visibility:** a test asserting `getThreadMessages` still returns a superseded error row (not filtered out) with a marker the frontend uses to render it collapsed.
- `e2e/tests/turn-retry.spec.ts` is extended (not replaced) to cover the now-visible failed-attempt row, since it already covers the retry chain shape.

---

## 6. Files Changed (expected)

| File | Change |
|---|---|
| `ui/src/hooks/use-thread.ts` | Add wiki-only SSE event handling (`wiki_updated`, `wiki_oriented`, `wiki_domain_created`); absorb `reorderMessagesForDisplay()` |
| `ui/src/pages/wiki/use-wiki-ingestion.ts` | Deleted |
| `ui/src/pages/wiki/ingestion-chat.tsx` | Rewired onto `useThreadInstance()` |
| `ui/src/pages/chat/index.tsx`, `ui/src/pages/workspaces/workspace-chat-tab.tsx` | Remove now-duplicated local `reorderMessagesForDisplay()` |
| `ui/src/components/assistant-message.tsx` | Render content + error indicator together instead of one replacing the other |
| `api/src/agents/thread-message-writer.ts` | Segment-based assistant row writes (`recordAssistantStart`/`finalizeAssistant`); pass real content to `failAssistant` |
| `api/src/agents/stream-handler.ts`, `wiki-stream-handler.ts`, `workspace-chat-stream-handler.ts` | Split text buffer at tool-call boundaries; pass accumulated content on failure |
| `api/src/services/thread-store.ts` | Remove the filter hiding superseded error rows in `getThreadMessages` |
| New/updated tests | Per Testing Plan above, including `e2e/tests/turn-retry.spec.ts` |

---

## 7. Out of Scope

- Tool-call card visual structure/content.
- Any formatting inconsistency not tied to ordering, error handling, or wiki/shared-hook duplication.
- Changes to the `retryOf` chaining mechanism itself, beyond making superseded rows visible.
