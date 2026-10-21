# Anthropic forced tool_choice & streamed content-block fixes — design

Related: thread report for thread `b89efadb-0e6e-44e9-9d84-b0b1d64e1a9e` (Anthropic
`claude-sonnet-5-5`, 2026-10-21) — the user-reported symptom was a chat turn
rendering "No response for this turn." in the UI despite the model genuinely
generating text, plus a 400 error on every AfterAgent background pipeline run
for the same thread.

Investigation found two independent, unrelated defects that both happen to
surface on current-generation Claude models (Sonnet 5.5, Opus 5.5, Fable 5.1,
Mythos 5.1). They are bundled into one spec and one fix because they were
investigated together and touch adjacent code, but they do not share a root
cause.

## Problem

### Bug 1 — assistant turns persist with empty content on the Anthropic provider

`pipeEvents()` in `api/src/agents/stream-handler.ts` (the function that turns
`agent.streamEvents()` output into both the live SSE `text_delta` stream and
the persisted `thread_messages` row) only recognizes streamed text when
`evt.data.chunk.content` is a `string`:

```ts
case 'on_chat_model_stream': {
  const content = evt.data?.chunk?.content;
  if (typeof content === 'string' && content.length > 0) {
```

That assumption is false for `@langchain/anthropic` (pinned `1.5.12`) whenever
the request has tools bound — which is every real turn through this agent (26
tools in the reported trace). Traced into the installed package
(`utils/message_outputs.js`):

```js
const coerceContentToString = !_toolsInParams(payload) && !_documentsInParams(payload)
  && !_thinkingInParams(payload) && !_compactionInParams(payload);
```

`_toolsInParams` is `tools.length > 0`. With tools bound, every
`content_block_delta` chunk comes back as `content: [{ index, type: 'text',
text: '<delta>' }]` — an array, never a string — so the `typeof content ===
'string'` check fails on every chunk. `flushDelta` never runs, the assistant
message accumulates no content, and that empty string is exactly what gets
persisted via `finalizeAssistant`. `ui/src/components/assistant-message.tsx`
then correctly renders "No response for this turn." — the message really was
persisted empty; this is not a rendering bug.

**Confirmed from the real trace:** the `ChatAnthropic` observability span's
`Output` field shows the model's real final text ("I read one recipe in full,
Natasha's Kitchen...") because the observability handler reads the
fully-aggregated final message, not the raw streaming chunks `pipeEvents`
consumes. The two don't observe the same data, which is why the trace and the
chat window disagree.

**Scope of impact:** `pipeEvents` is shared by every turn runner — chat,
workspace chat, task execution, headless/wakeup turns, and wiki ingestion
(`workspace-chat-stream-handler.ts`, `task-execution.ts`, `headless-turn.ts`,
`wiki-stream-handler.ts` all import it) — and only Anthropic triggers it;
OpenAI's and Ollama's LangChain wrappers emit plain-string deltas regardless
of tool binding. No existing test in `stream-handler.test.ts` feeds
`pipeEvents` anything but plain-string `chunk.content` — the gap was never
exercised against the real Anthropic+tools shape.

**A real hazard in the content-block array, not just a missing case:** when
tools are bound, the *same* `on_chat_model_stream` stream interleaves text
deltas (`{type: 'text', text: ...}`) and tool-argument deltas (`{type:
'input_json_delta', ...}`), distinguished only by `block.type`. A fix that
naively stringifies the whole array would leak raw tool-call JSON fragments
into the visible chat text. The fix must filter to `type === 'text'`
specifically.

### Bug 2 — AfterAgent (and the RLM adapter) 400 on forced tool_choice

`invokeStructured()` in `api/src/agents/after-agent.ts:295-307` calls
`llm.withStructuredOutput(schema)` with no `method` option.
`ChatAnthropic.withStructuredOutput()` defaults to `method: "functionCalling"`,
which — since the provider is constructed with no `thinking` config
(`provider-factory.ts:175-185`) — forces `tool_choice: { type: "tool", name:
... }`.

Claude Sonnet 5.5, Opus 5.5, Fable 5.1, and Mythos 5.1 all reject forced
`tool_choice` (`any`/`tool`) outright with a 400 — a documented breaking
change for that model generation, not a transient error:

```
400 {"type":"error","error":{"type":"invalid_request_error",
"message":"tool_choice: type \"tool\" and \"any\" are not supported for this model."}}
```

This fires identically on all four of AfterAgent's structured calls
(`summarize`/`classify`/`extract`/`merge-page`), each retried 3× by
`.withRetry({ stopAfterAttempt: 3 })`, then the pipeline's outer `try/catch`
(`after-agent.ts:682-689`) swallows it and marks the turn `'error'` — which is
why it never surfaces to the user and is fully decoupled from Bug 1
(`afterAgentMiddleware` is explicitly fire-and-forget: `void
runAfterAgentPipeline(...)`, never awaited).

`api/src/agents/loop-reflection.ts` calls the same `invokeStructured()`
helper, so it inherits this bug and this fix for free — no separate change
needed there.

**A second call site with the identical shape:**
`api/src/services/rlm-adapter.ts:42` (`LangChainInferenceAdapter.invoke()`,
used by the `rlm_query` tool via `createProvider(rlmConfig.provider, ...)` —
any configured provider, not just Anthropic) calls
`this.model.withStructuredOutput(options.schema)` with no `method` override.
This is not reported as broken today, but it is the same defect and will hit
the same 400 the first time `rlm_query` runs against a current-generation
Claude model with a schema. Fixed in the same change since the fix is
identical and already understood.

## Scope

**In scope — all in one PR:**
- `api/src/agents/stream-handler.ts` — new `extractStreamText()` helper +
  one call-site change in `pipeEvents`'s `on_chat_model_stream` case
- `api/src/agents/after-agent.ts` — `withStructuredOutput(schema, { method:
  'jsonSchema' })` in `invokeStructured()`
- `api/src/services/rlm-adapter.ts` — same `{ method: 'jsonSchema' }` change
  in `LangChainInferenceAdapter.invoke()`
- New/updated tests adjacent to each (per `api/AGENTS.md`'s convention)

`api/src/agents/loop-reflection.ts` needs no direct change (inherits the
`after-agent.ts` fix via the shared helper).

**Out of scope (explicit decisions, not oversights):**
- `api/src/agents/content-block-sanitizer.middleware.ts` and the bug it fixes
  (raw `input_json_delta` fragments leaking into persisted LangGraph
  checkpoint messages, breaking a later provider switch) — a separate,
  already-resolved issue; neither bug here touches checkpoint state.
- Retroactively repairing threads that already have empty-content assistant
  rows from Bug 1 — out of scope; the fix only prevents new occurrences.
- Full test backfill for `rlm-adapter.ts` (currently has zero tests) — only
  the changed line gets covered here, not the whole file.
- An eval-suite scenario per `AGENTS.md`'s Evaluation-Driven Development
  rules — see "Testing" below for why these are treated as deterministic code
  bugs rather than LLM-facing behavior bugs.

## Approach

### Bug 2 fix

Identical one-line shape in both files:

```ts
// after-agent.ts:302
const chain = llm.withStructuredOutput(schema, { method: 'jsonSchema' }).withRetry({ stopAfterAttempt: 3 });
```

```ts
// rlm-adapter.ts:42
const structured = this.model.withStructuredOutput(options.schema, { method: 'jsonSchema' });
```

`method: "jsonSchema"` routes through each provider's native structured-
output surface (`output_config.format` on Anthropic, `response_format:
json_schema` on OpenAI, `format: <schema>` on Ollama) instead of forcing a
tool call, so the Sonnet 5.5/Opus 5.5/Fable 5.1/Mythos 5.1 restriction never
comes into play. Confirmed against `@langchain/ollama` `1.3.0` (the exact pinned version) and
`@langchain/openai` `1.6.3` (one patch ahead of the pinned `1.6.2` — same
`withStructuredOutput` logic, re-verify on the exact pinned version at
implementation time if that matters) that `"jsonSchema"` is already each
provider's own default when `method` is unspecified — this is a
no-op behavior change for OpenAI and Ollama traffic through `rlm-adapter.ts`,
and a targeted fix for Anthropic. No prompt changes needed on either side;
the schemas and validated output shape are unchanged, only the wire mechanism
used to get there.

No error-handling changes needed: `invokeStructured()`'s existing
`.withRetry({ stopAfterAttempt: 3 })` and `runAfterAgentPipeline()`'s outer
try/catch (sets AfterAgent status to `'error'`, never throws back into the
fire-and-forget hook) already handle failure correctly — they were retrying a
request that could never succeed. `rlm-adapter.ts` has no retry wrapper today
and this change doesn't add one.

### Bug 1 fix

New helper in `stream-handler.ts`, colocated with the existing
`ParseState`/`flushDelta` helpers:

```ts
// evt.data.chunk.content from @langchain/anthropic is a plain string only
// when no tools/documents/thinking/compaction are in the request. This agent
// always binds tools, so every real turn gets an array of content blocks
// instead — text deltas AND tool-argument deltas interleaved, distinguished
// only by block.type. Only 'text' blocks are ever meant to reach the visible
// chat text; anything else (input_json_delta, thinking, signature_delta,
// ...) is a different content stream entirely and must never be
// concatenated in.
function extractStreamText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text: string } => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}
```

Call-site change in `pipeEvents`'s `on_chat_model_stream` case
(`stream-handler.ts:259-261`):

```ts
case 'on_chat_model_stream': {
  const content = extractStreamText(evt.data?.chunk?.content);
  if (content.length > 0) {
    // ...unchanged flushDelta/segment-splitting logic below
```

Everything downstream — `flushDelta`'s `<think>` tag parsing, the tool-call
segment-splitting logic, `drainBuffer`, `finalizeAssistant` — is untouched.
This is a pure input-normalization fix at the single point where raw event
data enters the existing pipeline. Providers that already send plain strings
(OpenAI, Ollama) are unaffected, since `extractStreamText` returns a string
input unchanged.

**Data flow:** `agent.streamEvents()` → `pipeEvents()`'s
`on_chat_model_stream` case → `extractStreamText()` → `flushDelta()`
(thought-tag parsing + live SSE `text_delta` emission) → `parse.content`
accumulates → returned as `finalContent` → `finalizeTurn()` →
`finalizeAssistant()` persists the `thread_messages` row the UI reads. Fixing
it at the `extractStreamText` boundary means every downstream consumer (live
SSE stream and persisted row alike) gets the fix for free, and it applies
uniformly across every turn runner that shares `pipeEvents`.

## Testing

**`stream-handler.test.ts` (Bug 1):**
- Unit tests for `extractStreamText` in isolation: string passthrough; a
  single `{type:'text', text:...}` block; multiple text blocks concatenated
  in order; a mix of `'text'` and `'input_json_delta'` (or other non-text)
  blocks — only text contributes, confirming no JSON-fragment leakage;
  `undefined`/non-array/non-string input returns `''`.
- One orchestration-level regression test on `pipeEvents` itself: an event
  stream shaped like the real trace (text-delta content-block-array chunks
  interleaved with `on_tool_start`/`on_tool_end`), asserting the final
  returned `content` matches the expected full text. Written to fail against
  today's code and pass after the fix.
- All existing string-content tests stay unchanged as a regression guard
  that the OpenAI/Ollama plain-string path is untouched.

**`after-agent.test.ts` (Bug 2):** extend the existing fake-model spy to
assert `invokeStructured()` calls `.withStructuredOutput(schema, { method:
'jsonSchema' })` — same args-check pattern the file already uses for
`setNextSpanName`.

**`rlm-adapter.test.ts` (Bug 2, new file):** one minimal fake-`BaseChatModel`
test (same shape as the fakes already in `after-agent.test.ts` /
`loop-reflection.test.ts`) asserting the `options.schema` branch calls
`withStructuredOutput(schema, { method: 'jsonSchema' })` and that the result
flows into `InferenceResponse.structured`. Per the Scope section, this is the
only test added for this file — not a full backfill.

**Error handling:** no new error paths for either bug. Both are fixes to
code whose failure handling already works correctly (retry + outer catch for
AfterAgent; existing partial-content/`PipeEventsError` handling for
streaming) — it just was never reached in a correct state before.

**On `AGENTS.md`'s Evaluation-Driven Development rules:** both bugs are
treated as deterministic code defects, not LLM-facing behavior — content-
block parsing and structured-output request construction are fully testable
with mocked models and don't depend on what a live model actually says. No
eval-suite scenario is added for either; this is a deliberate scoping
decision, not an oversight.

## Rollout

Single commit/PR covering all three source files and their tests. Standard
pre-commit gate from repo root before committing, per `AGENTS.md`:

```sh
npm run lint
npx prettier --check .
npm test
```
