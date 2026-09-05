# Context-Window Trimmer Ignores Tool-Schema Overhead — Design

**Date:** 2026-09-04
**Status:** Approved
**Issue:** [#127 — Context-window trimmer doesn't keep chat threads under configured token ceiling](https://github.com/tkottke90/amazing-hashbrown/issues/127)

---

## 1. Problem & Goal

`contextWindowMiddleware` (`api/src/agents/chat-agent.ts:108-135`) is supposed to keep every chat turn under `chat.contextWindow.maxTokens` (default 32,000). A real workspace-chat turn reported `inputTokens: 43964` against that 32,000 ceiling — 137% over budget.

Root cause, confirmed by reading the installed `langchain`/`@langchain/langgraph` middleware types and the observability code:

- The middleware trims `state.messages` inside its `beforeModel` hook, whose token count comes from `estimateTokens` — a plain sum of `text.length / 4` over the message list (`chat-agent.ts:96-101`).
- `beforeModel`'s signature (`(state, runtime) => ...`) has **no visibility into the bound tool list at all** — not in `state`, not in `runtime`. The agent binds 20+ tool schemas (`makeShellExecTool` + `STATIC_CHAT_TOOLS` + gated + wiki-write + MCP tools), none of which factor into the trim decision.
- The real `inputTokens` reported in `usage_stats` (`observability-handler.ts:82-90`) comes straight from the provider's `usage_metadata.input_tokens` — which _does_ include the tool-schema payload sent with the request.
- The only middleware hook that sees the actual tool list is `wrapModelCall`, via `request.tools` — and that list is itself dynamic per turn: `skillGatedToolsMiddleware` (`skill-gated-tools.middleware.ts`) filters it in its own `wrapModelCall`, which runs earlier in the same `middleware: [...]` array and therefore wraps `contextWindowMiddleware` from the outside (LangChain composes the array outer-to-inner).

So the trimmer was never checking the number that actually matters, and structurally couldn't from where it lived.

**Goal:** close the blind spot without adding per-provider tokenizers, network round-trips, or new dependencies. Anthropic's own token-counting guidance explicitly rules out using a tool like `tiktoken` as a stand-in for Claude's tokenizer (it undercounts Claude tokens by 15-20%+), and this app is multi-provider (Ollama/OpenAI/Anthropic — see `provider-factory.ts`) with no shared real tokenizer available across all three anyway. The fix stays a heuristic, but an honest one: it now counts what it was blind to, and adds a safety margin to absorb the estimate's known slop instead of pretending to be exact.

---

## 2. Design — two-stage trim, split by concern

`contextWindowMiddleware` keeps its existing `beforeModel` hook and gains a new `wrapModelCall` hook. Each has a distinct job:

1. **`beforeModel` (unchanged)** — coarse, message-only trim against `cfg.maxTokens`, run before tools are even in the picture. Its role going forward is bounding what gets _persisted_ to the SQLite checkpoint over a long-running thread — it returns `{ messages: trimmed }`, which prunes graph state, not just what's sent to the model this turn. It cannot enforce the real per-call budget because it structurally can't see tools; that's not a gap to close here, it's a different, legitimate concern (storage growth) that this hook was already handling correctly.
2. **`wrapModelCall` (new)** — the actual enforcement point. This is the only hook with `request.tools` (already filtered by `skillGatedToolsMiddleware`, since that middleware's `wrapModelCall` wraps this one). It computes the real per-turn budget and re-trims `request.messages` before calling `handler()`. This trim is call-scoped only — it does not write back to graph state.

### `wrapModelCall` logic

```ts
const cfg = env.chat?.contextWindow;
if (cfg?.enabled === false) return handler(request);

const toolsTokens = estimateToolsTokens(request.tools);
const systemTokens = estimateTokens([request.systemMessage]); // or equivalent text estimate
const ceiling = (cfg?.maxTokens ?? 32000) * (cfg?.safetyMarginPct ?? 0.85);
const budget = Math.max(ceiling - toolsTokens - systemTokens, MIN_BUDGET_FLOOR);

const trimmer = trimMessages({
  maxTokens: budget,
  strategy: 'last',
  tokenCounter: estimateTokens,
  includeSystem: false, // system already counted separately above
  allowPartial: false,
  startOn: 'human',
});
const trimmed = await trimmer.invoke(request.messages);

if (trimmed.length !== request.messages.length) {
  logger.debug('contextWindow: trimmed at wrapModelCall (tool-schema-aware)', {
    before: request.messages.length,
    after: trimmed.length,
    toolsTokens,
    systemTokens,
    budget,
  });
}

return handler({ ...request, messages: trimmed });
```

`estimateToolsTokens` is a new helper alongside the existing `estimateTokens`: for each tool in `request.tools`, it runs the shared `estimateTokensForText` (from `@tkottke90/llm-common-types/tokens`) over the tool's serialized JSON-schema text plus `tool.description ?? ''`, and sums the result.

**Implementation note:** `tool.schema` on these tools is a Zod schema instance (e.g. `WikiSearchSchema` in `wiki-search.tool.ts`), not plain JSON — `JSON.stringify(tool.schema)` would not serialize its shape (Zod instances carry their definition in a form plain `JSON.stringify` doesn't walk) and would silently undercount, defeating the fix. The estimator must convert each tool's schema to its actual JSON-schema form first — the same conversion LangChain performs internally when binding tools to a provider request — before stringifying. The implementation plan should pin down the exact utility to reuse (LangChain/`zod`'s own schema-to-JSON-schema conversion) rather than reimplementing one, so the estimate tracks whatever LangChain actually sends on the wire.

### One lever, not two

The original investigation considered two ways to make the char/4 heuristic more honest: (a) a denser per-token constant for JSON/schema content, and (b) a global safety margin. Going with **(b) only** — a single `safetyMarginPct` config value (default `0.85`, i.e. the trimmer targets 85% of `maxTokens`) — covers the same systematic underestimate on structured content without a second knob to calibrate and maintain. Simpler, same protection.

### `MIN_BUDGET_FLOOR`

A constant (2000 tokens) guarding the case where tool-schema overhead alone would eat the entire ceiling — e.g. `maxTokens` configured too low for the bound tool set. Rather than trimming to zero or a negative budget (which would break `trimMessages`'s `startOn: 'human'` pairing requirement), the budget floors at this value and logs a `warn` (not the routine `debug` trim log), since hitting the floor means the configured ceiling genuinely cannot be honored for this tool set — a config problem, not something to silently paper over.

---

## 3. Config change

`ContextWindowSchema` in `api/src/config/env.ts` gains one field:

```ts
export const ContextWindowSchema = z.object({
  enabled: z.boolean().default(true),
  maxTokens: z.number().default(32000),
  safetyMarginPct: z.number().default(0.85),
});
```

---

## 4. Error handling / edge cases

- `cfg?.enabled === false` short-circuits `wrapModelCall` the same way it already does in `beforeModel` — calls `handler(request)` unmodified, no trimming.
- Tool schema serialization is not specially guarded — schemas come from the tool factories and are always valid JSON-serializable objects; a `JSON.stringify` failure here would indicate a bug elsewhere worth surfacing, not swallowing.
- Hitting `MIN_BUDGET_FLOOR` logs at `warn` with the computed `toolsTokens`/`systemTokens`/`ceiling` so it's diagnosable from logs alone.

---

## 5. Out of Scope

- **Real per-provider token counting** (Anthropic's `messages.countTokens`, `tiktoken` for OpenAI, etc.) — considered and rejected for this middleware. This trimmer's job is "stay safely under the ceiling," not "report a billing-accurate count"; real counting would add a network round-trip to every chat turn (Anthropic) or per-provider branching (three separate counting paths) for precision this use case doesn't need. Worth revisiting only if a future feature (e.g. a cost dashboard) needs billing-accurate counts — that would be a separate, additive change, not a modification of this hot path.
- **Calibrating the char/token constant by content type** — considered alongside the safety margin, dropped in favor of the single-lever approach (see §2).

---

## 6. Testing

- New unit tests for `estimateToolsTokens` against a fixture tool list with known schema sizes.
- New unit test for `wrapModelCall`: a message list that fits under `maxTokens` alone but not once tool-schema overhead is added gets trimmed — this is the direct regression test for #127.
- New unit test for the `MIN_BUDGET_FLOOR` path and its `warn` log.
- Existing `beforeModel` tests in `chat-agent.test.ts` need no changes — that hook's logic is unchanged.
