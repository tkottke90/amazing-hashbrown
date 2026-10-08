# Provider-switch content-block leak — design

Related: [tkottke90/amazing-hashbrown#281](https://github.com/tkottke90/amazing-hashbrown/issues/281)

## Problem

Every chat-facing agent (main chat, workspace chat, task execution, the
after-agent sub-agent, and wiki-ingestion) shares one SQLite-backed
LangGraph checkpointer (`getCheckpointer()` in `chat-agent.ts`), keyed only
by `thread_id` — never by provider. Each turn resolves its own provider
independently (`createProvider(provider, model)` in
`services/provider-factory.ts`), but the message history LangGraph loads
from the checkpoint is whatever a _previous_ turn wrote there, regardless of
which provider wrote it.

`@langchain/anthropic`'s streaming assembles a tool-call content block from
Anthropic's raw SSE deltas (`content_block_start` → `input_json_delta`\* →
`content_block_stop`). When that assembly doesn't fully collapse, a raw
`input_json_delta` fragment survives into the persisted `AIMessage.content`
array. This is inert on Anthropic (which understands its own raw blocks)
and on OpenAI's real API (permissive), but is rejected outright by stricter
OpenAI-compatible gateways (observed against Digital Ocean's `glm-5.3-flash`
endpoint):

```
400 Unsupported chat content part type: 'input_json_delta'. Supported
types: ... (parameter=type, value=input_json_delta)
```

Concretely: a thread runs one or more tool-calling turns on
`anthropic/claude-sonnet-5`, the user switches the thread's provider to
`Digital Ocean/glm-5.3-flash`, and the very next turn fails immediately —
the thread is unusable on the new provider without starting a fresh one.

Installed versions are several patches/minors behind latest
(`@langchain/anthropic` 1.5.1 vs. 1.5.12, `@langchain/core` 1.2.2 vs.
1.2.17, `langchain` 1.5.2 vs. 1.5.16, `@langchain/langgraph` 1.4.4 vs.
1.4.21, `@langchain/langgraph-checkpoint-sqlite` 1.0.3 vs. 1.0.4,
`@langchain/openai` 1.5.5 vs. 1.6.2 — the last one a minor bump). There's no
confirmed upstream changelog entry naming this exact fix, but a March-2026
LangChain core release note mentions "better streaming chunk merging for
cases where providers omit index fields on tool calls," which is plausibly
the same class of bug.

## Scope

All five agent builders that share the checkpointer:

- `chat-agent.ts`: `buildChatAgent`, `buildWorkspaceChatAgent`,
  `buildTaskAgent`, the after-agent sub-agent builder
- `wiki-ingestion-agent.ts`: `buildWikiIngestionAgent`

Any of them can hit this the moment a thread's provider is switched after a
tool-calling turn — the fix applies to all of them, not just wiki-ingestion
(the only one the filed issue's repro happened to exercise).

## Approach — two phases

This is a staged fix: Phase 2 only happens if Phase 1's verification gate
doesn't clear.

### Phase 1 — dependency bump, gated by a deterministic repro test

Because this session (and CI) has no live Anthropic/Digital Ocean
credentials, "does the bump fix it" can't be verified by replaying a real
thread. Instead:

**Repro test** (new file, co-located with `provider-factory.ts` or
`chat-agent.ts` — exact location pinned at implementation time): construct a
`ChatAnthropic` instance with a dummy API key, stub its underlying
`@anthropic-ai/sdk` client's streaming call to yield a fabricated async
iterator of real Anthropic SSE events modeled directly on the `wiki_lint`
tool call from the originating bug report's trace:

```
message_start
content_block_start  (type: tool_use, name: wiki_lint)
input_json_delta     ×N  (splitting `{"wikiId":"user"}` across chunks)
content_block_stop
message_stop
```

Run that through `ChatAnthropic.stream()`, concatenate the chunks the same
way LangGraph's checkpoint-writing path does, and assert the final merged
`AIMessage.content` contains zero blocks of type `input_json_delta` — only
`tool_use`/`text` blocks survive.

This test is written and run **before** the bump (expected: fails, proving
the repro is real and not a fabrication artifact) and **after** the bump
(pass = bump fixed it; fail = proceed to Phase 2). It stays in the suite
permanently either way — regression coverage against this exact failure
mode, and against any future upstream regression of the same shape.

**Bump**: update `@langchain/anthropic`, `@langchain/core`, `langchain`,
`@langchain/langgraph`, `@langchain/langgraph-checkpoint-sqlite`, and
`@langchain/openai` to the versions named above (wherever they're declared
— root `package.json` and/or `api/package.json`, confirmed at
implementation time). Then run the full pre-commit gate from repo root:
`npm run lint && npx prettier --check . && npm test`. `@langchain/openai`'s
minor-version jump gets particular scrutiny here since it's the one
dependency in this set that isn't a pure patch bump.

**If the repro test passes after the bump**: done. Commit the bump plus the
now-passing repro test; no middleware needed. Mark this resolved in the
linked issue.

### Phase 2 — sanitizing middleware (only if Phase 1's repro test still fails)

A new composable middleware,
`api/src/agents/content-block-sanitizer.middleware.ts`:

```ts
createMiddleware({
  name: 'ContentBlockSanitizerMiddleware',
  beforeModel: async (state) => {
    // Walk state.messages; for any AIMessage whose content is an array,
    // filter out any block whose `type` isn't in the known-safe allowlist
    // (text, tool_use/tool_call, thinking/reasoning, image, tool_result —
    // exact list pinned from @langchain/core's standard content-block
    // types at implementation time). Log a warning (threadId + stripped
    // type) whenever a block is actually removed — worth seeing in prod
    // logs even after the fix ships, as a signal the upstream bug
    // resurfaced.
  },
});
```

This runs regardless of which provider is being called on a given turn, so
it's a permanent guardrail against this entire _class_ of bug (a raw,
provider-specific streaming artifact leaking into shared checkpoint state),
not just this one instance of it.

**Registration**: added as the _first_ entry in all five builders'
middleware arrays (`chat-agent.ts` × 4, `wiki-ingestion-agent.ts` × 1) — runs
before `createContextWindowMiddleware` and everything else, so nothing
downstream ever sees the bad block.

**Tests**:

- Unit test for the middleware in isolation: feed it a `state.messages` with
  a planted `input_json_delta` block, assert it's stripped and every other
  block/message passes through unchanged.
- One orchestration test per agent builder (or a shared fixture, if the five
  builders' middleware arrays are similar enough to parametrize) confirming
  the sanitizer is actually registered and runs ahead of the model call —
  interactions/wiring, not re-testing the filtering logic itself.

## Rollout

- Commit the bump (and, if needed, the middleware) to this branch.
- Mark `TODO_LIST.md`'s relevant item complete on this branch if this maps
  to an existing tracked item there; otherwise no `TODO_LIST.md` change is
  needed — this is a bugfix, not a tracked feature.
- Comment on
  [tkottke90/amazing-hashbrown#281](https://github.com/tkottke90/amazing-hashbrown/issues/281)
  with which phase resolved it.

## Outcome

Both phases ran. Phase 1's repro test (`api/src/services/anthropic-tool-call-streaming.test.ts`)
failed before the bump as expected, and **still failed after it** — traced
directly to source: `@langchain/anthropic`'s `input_json_delta` branch
(`utils/message_outputs.js`) sets `type: data.delta.type` literally instead
of normalizing it the way its sibling `text_delta`/`thinking_delta`
branches do, and `@langchain/core`'s generic same-index merge
(`getMergeableTypeBase` in `messages/base.js`) strips the `_delta` suffix
to compare block-type bases — `"input_json_delta"` strips to
`"input_json"`, which never matches the original block's `"tool_use"`
type, so the delta is never merged back in and survives as its own
stray array entry. Confirmed byte-identical in both the originally-pinned
versions and the latest available (`@langchain/anthropic` 1.5.12,
`@langchain/core` 1.2.17) — not fixed upstream as of this writing. The
dependency bump was kept anyway (full test suite green, no regressions),
and the repro test was converted into a permanent **canary** (inverted to
assert the bug's current presence, so it passes today and only goes red
if upstream actually fixes it) rather than a `must-pass-when-fixed`
regression test — the design didn't account for this repo's
all-tests-must-pass pre-commit gate, and a permanently-red test can't
satisfy that.

Phase 2 shipped as `api/src/agents/content-block-sanitizer.middleware.ts`,
registered first in all five middleware arrays. One refinement from the
original spec: instead of an allowlist of "known-safe" block types (which
risks false-positives against legitimate Anthropic block types this
codebase doesn't otherwise construct — `thinking`, `redacted_thinking`,
`tool_result`, `server_tool_use`, etc.), it strips by **suffix**
(`type.endsWith('_delta')`) — every Anthropic streaming delta-event type
follows this naming convention and none of them are ever a legitimate
settled block, so this can't have that false-positive failure mode and
needs no exhaustive type enumeration pinned from the library's internals.

The planned "one orchestration test per distinct middleware-array shape"
was dropped: there's no existing precedent in this codebase for testing a
fully-constructed agent's middleware wiring (every existing
`*.middleware.test.ts` tests the middleware factory in isolation, the same
pattern this fix's own middleware test follows), building one would need
the full `buildChatAgent`/`buildWikiIngestionAgent` dependency graph (DB,
checkpointer, tools manager, skills manager), and the registration itself
is a trivial, already grep-verified array insertion — disproportionate
cost for the value added here.

## Out of scope

- Fixing this inside `@langchain/anthropic` itself (upstream's problem, not
  ours to patch).
- Retroactively cleaning up any thread whose checkpoint _already_ has a
  corrupted message in it from before this fix ships — those threads stay
  broken until the user starts a fresh thread or the checkpoint is manually
  edited. Not handled here; flag as a possible follow-up if it turns out to
  matter in practice.
