# Streamed-Text Buffer Draining Fix — Design

**Date:** 2026-11-23
**Status:** Approved
**Issue:** None filed — a small, fully-diagnosed bug fix, no design trade-offs requiring issue tracking.

---

## 1. Problem & Goal

`api/src/agents/stream-handler.ts`'s thought-block parser (`flushDelta`) always withholds up to `SAFE_MARGIN` (8) trailing characters of streamed text in `parse.buf`, to guard against a `<think>`/`</think>` tag being split across chunk boundaries. `drainBuffer` is the only thing that flushes that withheld tail into `parse.content`/`parse.thought` (and emits the matching SSE delta).

Two call sites in `pipeEvents` never drain it:

1. **The `catch` block (lines 356-358).** When the event stream throws mid-turn (most commonly `GraphRecursionError` on an Exhausted Run), `PipeEventsError` is built directly from `parse.content`, skipping `drainBuffer` entirely. Up to 8 already-generated characters are silently and permanently lost. This is what produced a Task Run's last assistant message ending mid-word ("...the proven invocatio") — text that then propagates, unflushed, into both the live chat row and the Task Drawer's "Why this got stuck" field (`task-execution.ts` ~1294-1304 uses the same recovered partial content as both the chat row and the Run's `summary`; `ui/src/components/task-drawer.tsx:1015` renders that `summary`).
2. **The `on_tool_start` case (lines 310-329).** When a tool call begins, nothing drains the withheld tail either. On an otherwise clean-finishing turn this isn't data loss — the tail is eventually flushed, either at the next text segment after the tool call (the existing `toolCallPendingSinceLastText` branch) or at turn-end (line 360) — but it means the live chat UI visibly stalls up to 8 characters short of what the model actually said while the tool runs, then "catches up" later. Observed in practice as a seemingly-unmotivated pause before a tool call.

**Goal:** no streamed text is ever lost on a mid-stream throw, and the live chat UI reflects the model's actual in-flight text immediately when a tool call starts, rather than delaying or discarding the last few characters.

**Out of scope:**

- Why the underlying `GraphRecursionError` (or other throw) happens in the first place — that's ADR-0056's Exhausted Run / Narrowed Retry machinery, unaffected by this fix.
- Any change to `SAFE_MARGIN`'s value or the `<think>`/`</think>` tag-splitting logic itself — only when the withheld tail gets flushed, not how it's computed.

## 2. Approach

Add a `drainBuffer` call at both of the two gaps identified above, mirroring the call already made on the clean-finish path (line 360) and in the existing tool-call-to-text transition branch. No change to `ParseState`, `flushDelta`, `SAFE_MARGIN`, or any other consumer's interface — this only changes when `parse.buf`'s withheld tail gets flushed into `parse.content`/`parse.thought`, never what ends up in them once fully drained.

## 3. Components

### 3.1 `api/src/agents/stream-handler.ts` — `pipeEvents`

- **`catch` block (~356-358):** call `drainBuffer(sink, currentSegmentId, parse)` before constructing `PipeEventsError`, so `parse.content`/`parse.thought` already hold the full in-flight text (and the client has already received the final `text_delta`/`thought_delta` for it) by the time the error is thrown and caught upstream. Writing an SSE event from this catch block is consistent with existing precedent — three other catch blocks in this same file/`chat-agent.ts` already call `writeSseEvent` directly inside error recovery (~1073-1090, ~1265-1282, ~1452-1469) to push a canned "ran out of steps" message live; `drainBuffer`'s own `writeSseEvent` call is the same shape.
- **`on_tool_start` case (~310-329):** call `drainBuffer(sink, currentSegmentId, parse)` at the top of the case, before `toolCallPendingSinceLastText = true` is set. This is a no-op wherever there's nothing withheld (`drainBuffer` already guards on `state.buf` being non-empty), so it doesn't disturb the existing segment-finalization logic that runs later in the `on_chat_model_stream` branch (`toolCallPendingSinceLastText && parse.content.length > 0` → drain + `finalizeAssistant` + new segment) — that branch's own `drainBuffer` call simply becomes a no-op in the common case, since this new call already flushed the tail.

No other function in this file changes.

## 4. UI

No UI change. `ui/src/components/task-drawer.tsx:1015` and the chat thread already render whatever text `pipeEvents`/`task-execution.ts` hand them — this fix changes what that text contains, not how either surface displays it.

## 5. Evaluation-Driven Development

Not applicable. This is deterministic stream-parsing/buffering logic, not LLM-facing behavior — no model output or tool-choice decision changes, so this repo's EDD rule (root `AGENTS.md`) doesn't apply.

## 6. Testing

- **`stream-handler.test.ts`** (`[unit]`):
  - Update the existing "wraps a mid-stream failure in `PipeEventsError`..." test (~1350-1376): change `expect(longChunk.startsWith(err.partialContent)).to.equal(true)` to an exact-match assertion (`err.partialContent` equals the full `longChunk`, not just a prefix of it).
  - New test: a throwing stream whose last chunk is shorter than `SAFE_MARGIN` confirms the full text (not a truncated prefix) survives into `PipeEventsError.partialContent`, asserting byte-for-byte equality against the input chunk(s).
  - New test: an `on_tool_start` event immediately following `on_chat_model_stream` text asserts the sink receives a `text_delta` for the full withheld tail (via `drainBuffer`) at `on_tool_start` time, not deferred to the next text segment or turn-end.
- **`task-execution.test.ts`** (`[orchestration]`): update the existing partial-content assertion (~2149-2151) from `expect('Running the command...').to.include(partialContent)` to exact equality between the recorded assistant row's content and the full streamed text.

No test changes needed in `wiki-stream-handler.test.ts` or `workspace-chat-stream-handler.test.ts` — both call the same shared `pipeEvents`, so the fix and its unit-level coverage in `stream-handler.test.ts` cover them without duplication.

## 7. Follow-up

None identified.

## 8. Acceptance Criteria

- A Run that ends via a mid-stream throw (e.g. `GraphRecursionError`) preserves the agent's full in-flight text — including the last `SAFE_MARGIN` characters — in both the live chat row and the Task Drawer's "Why this got stuck" field; no mid-word truncation.
- A tool call starting mid-turn no longer visibly stalls the live chat UI a few characters short of what the model actually generated — the withheld tail flushes immediately when the tool call starts.
- `stream-handler.test.ts` and `task-execution.test.ts` assert exact content equality on the mid-stream-throw and tool-call-start paths, not prefix-tolerant matches.
