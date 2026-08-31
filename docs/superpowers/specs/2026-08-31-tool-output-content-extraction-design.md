# Tool Output Content Extraction — Design

**Date:** 2026-08-31
**Status:** Approved
**Issue:** [#110 — Enhancement: Show only tool result content instead of raw LangChain message](https://github.com/tkottke90/amazing-hashbrown/issues/110)

---

## 1. Problem & Goal

The Tool Message component (chat thread) and the Thread Report both display tool call results as the full raw LangChain `ToolMessage` object — `{lc, type, id, kwargs: {content, tool_call_id, ...}}` — instead of just the result text. This exposes internal LangChain serialization details that are irrelevant to a user trying to understand what a tool did.

Goal: both surfaces show only the tool's actual result text (`content`). Full raw payloads remain available through the observability/tracing layer, which is unaffected by this change.

---

## 2. Root Cause

In `api/src/agents/stream-handler.ts`, the `on_tool_end` handler (lines 162–184) captures the tool's result as:

```ts
const outputs = evt.data?.output;
```

At this point `outputs` is a **live** LangChain `ToolMessage` instance (LangGraph's `ToolNode` always wraps a tool's return value in one), so `outputs.content` is directly accessible. The raw envelope only appears later, when this value is implicitly serialized:

- **Persistence:** `finalizeToolCall()` (`api/src/agents/thread-message-writer.ts:135-149`) stores `outputs` unmodified in the message payload; `thread-store.ts` then `JSON.stringify()`s that payload to write it to SQLite. `JSON.stringify` on a LangChain `Serializable` instance invokes its `toJSON()`, which produces the `{lc, type, id, kwargs}` envelope. On read, `JSON.parse` returns that same shape unchanged.
- **Live streaming:** the same unmodified `outputs` is sent in the `tool_call_end` SSE event (`stream-handler.ts:177-181`), and the UI hook (`ui/src/hooks/use-thread.ts:326-329`) stores `evt.outputs` verbatim onto the thread message.

Both consumers — `ToolCallMessage` (`ui/src/components/tool-call-message.tsx:75-77`) and the Thread Report's Nunjucks template (`lib/thread-reports/templates/report.njk:169`, via the `json` filter / `formatJson` in `lib/thread-reports/src/render.ts:30-36`) — already render a plain string outputs value correctly (shown as-is) and only fall back to `JSON.stringify` for non-string values. Neither needs to change: the fix is to make sure `outputs` is already a plain string (or otherwise minimal) by the time it reaches either of them.

No existing utility in the codebase unwraps this envelope. `lib/evaluations/src/runner.ts`'s `extractContent()` is the closest analog but is scoped to a different problem (a live chat model's `.content`, with an Ollama-specific `reasoning_content` fallback) and lives in a package `api/src` has no reason to depend on for this.

---

## 3. Fix Design

**Scope:** `api/src/agents/` only. No changes to `ui/src/components/tool-call-message.tsx`, `lib/thread-reports/templates/report.njk`, or `lib/thread-reports/src/render.ts` — their existing string/non-string rendering fallback already does the right thing once the source data is clean.

**New file:** `api/src/agents/tool-output.ts`, exporting one pure function:

```ts
export function extractToolResultContent(output: unknown): unknown
```

Logic:

- If `output` is a non-null object with a `content` property (duck-typed — matches a `ToolMessage` instance without importing `@langchain/core`'s class for an `instanceof` check, keeping the function decoupled and trivially testable with plain objects), return that `content` value.
- Otherwise return `output` unchanged. This covers a value that's already a plain string, `null`/`undefined`, or any shape a tool might someday return that isn't a `ToolMessage`.
- `content` itself isn't guaranteed to be a string — LangChain allows multimodal content blocks (an array). It's passed through as-is; both render sites already `JSON.stringify` non-string values sensibly, so no special-casing is needed here.

**Call site:** `stream-handler.ts:165` changes from:

```ts
const outputs = evt.data?.output;
```

to:

```ts
const outputs = extractToolResultContent(evt.data?.output);
```

This is the single choke point both consumers (`finalizeToolCall`'s persisted payload, and the `tool_call_end` SSE event) already read from, so one line fixes both surfaces at once.

**Historical data:** threads already persisted in the DB keep the raw envelope baked into their stored JSON payload — this fix is forward-only, per product decision. No migration is performed. A future cleanup could add a defensive unwrap at render time if old-thread display ever becomes a priority, but that's explicitly out of scope here.

**Observability:** untouched. The observability/tracing store captures its own copies of tool call data independently of `thread-message-writer.ts`, so full raw payloads remain available there, satisfying the issue's explicit requirement.

---

## 4. Testing Plan

### Unit tests (new: `api/src/agents/tool-output.test.ts`)

- A real `ToolMessage` instance (from `@langchain/core/messages`) with string content → returns that string.
- A duck-typed plain object `{ content: [...] }` (non-string content, e.g. multimodal blocks) → returns the array unchanged.
- A plain string input → returned unchanged.
- `null` / `undefined` input → returned unchanged.
- An object with no `content` property → returned unchanged.

### Existing stream-handler tests

`stream-handler`'s existing `on_tool_end` test coverage should be checked for any assertion on the exact shape of `outputs`/the persisted payload and updated if it currently asserts the raw envelope shape — it should now assert the unwrapped content instead.

No new UI or Thread Report tests are needed, since neither rendering path changes.

---

## 5. Files Changed

| File                                        | Change                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| `api/src/agents/tool-output.ts`             | New — `extractToolResultContent()` pure function                                |
| `api/src/agents/tool-output.test.ts`        | New — unit tests for the extraction function                                    |
| `api/src/agents/stream-handler.ts`          | `on_tool_end` handler calls `extractToolResultContent()` on `evt.data?.output` |

---

## 6. Out of Scope

- Backfilling/migrating already-persisted threads whose stored payload contains the raw envelope.
- Changing the observability/tracing layer.
- Any change to `ui/src/components/tool-call-message.tsx` or `lib/thread-reports` rendering — their existing fallback logic already handles clean string output correctly.
- Token-estimation accuracy in `lib/thread-reports/src/build.ts` (`messageText`), which stringifies `inputs`/`outputs` for context sizing — it will incidentally become more accurate once `outputs` is clean, but that's not a goal being verified here.
