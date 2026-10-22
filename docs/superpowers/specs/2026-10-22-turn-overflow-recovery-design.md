# Turn Overflow Recovery — Design

**Date:** 2026-10-22
**Status:** Approved
**Issue:** [#354 — Context-window trim drops entire turn, including user message, when it can't fit budget](https://github.com/tkottke90/amazing-hashbrown/issues/354)
**Related:** [#353 — MCP gateway tool calls execute twice per request](https://github.com/tkottke90/amazing-hashbrown/issues/353) (contributing factor, not a dependency — see §5), [#127 — Context-window trimmer doesn't keep chat threads under configured token ceiling](https://github.com/tkottke90/amazing-hashbrown/issues/127) (closed; this design's gap exists in the code #127 introduced)
**Glossary:** `GLOSSARY.md` → "Chat Turns & Context Trimming" (**Turn**, **Turn Overflow**)
**ADRs:** [0041](../adr/0041-turn-overflow-recovers-via-truncation-not-interrupt.md), [0042](../adr/0042-context-budget-config-lives-in-agent-behavior-renders-in-model-providers.md)

---

## 1. Problem & Goal

`boundaryAwareTrim` (`api/src/agents/summary-boundary.ts`) falls back to `trimMessages({ strategy: 'last', startOn: 'human', allowPartial: false })` whenever no summary boundary is present (true for Thread chat, Wiki chat, and any workspace that hasn't summarized yet). When a single Turn's own message history already exceeds the trim budget — a **Turn Overflow** — that call has no valid cut point and returns an empty array: not a partial tail, not the Turn's Human message alone, nothing. Confirmed by reproducing the real `trimMessages` (`@langchain/core`) against the thread shape from the incident that opened #354.

This is called from two places, both exposed to the same failure:

- `wrapModelCall`'s call-scoped trim (`chat-agent.ts`) — an empty result here means the model receives a system prompt and tool schemas with no visible user message, and answers with a disconnected default reply (the "how can I help" greeting observed in #354's Thread Report).
- `beforeModel`'s trim — per #127's design, this result is `{ messages: trimmed }` and **is persisted to the SQLite checkpoint**. An empty result here would permanently delete the thread's real message history, not just degrade one reply.

**Goal:** guarantee a Turn Overflow never produces an anchorless/empty result from either call site, recover automatically where possible, and close one of the gaps that makes Turn Overflow likely in the first place (unbounded MCP tool output).

---

## 2. Design — three layers

### 2.1 `boundaryAwareTrim` never returns an anchorless result

When the existing fallback (`trimMessages(...)`) returns a result with no Human-type message, that signals Turn Overflow. `boundaryAwareTrim` then recovers from the **original, untrimmed** `messages`, not the anchorless result:

```ts
const trimmed = await trimMessages({ maxTokens, strategy: 'last', tokenCounter, includeSystem, allowPartial: false, startOn: 'human' }).invoke(messages);

if (hasHumanAnchor(trimmed)) return trimmed;

// Turn Overflow: fall back to the current Turn only, and make it fit.
return recoverTurnOverflow(messages, maxTokens, tokenCounter, threadId);
```

`recoverTurnOverflow`:

1. Slices `messages` to the current Turn — from the last Human message to the end.
2. While the Turn's token count exceeds `maxTokens`: finds the largest `ToolMessage` by content size (ties broken by position — oldest first), offloads its full content via the same `storeToolContent`/`toolStub` mechanism `web_fetch` already uses (`api/src/agents/tools/tool-stub.ts`, `api/src/services/tool-content-store.ts`), and replaces that message's `content` with a `toolStub()`-formatted stub carrying the real `threadId`/`toolKey` — so `get_tool_key` can still retrieve it in full. Never drops a whole message (would orphan an `AIMessage`'s `tool_calls` entry).
3. Stops as soon as the Turn fits, or when every `ToolMessage` in the Turn has already been reduced to its minimal stub size and it *still* doesn't fit — the same tier of problem `MIN_BUDGET_FLOOR` already treats as a misconfiguration today (tool-schema + system overhead alone exceeds the ceiling). That case throws a new `ContextBudgetExceededError` (lives in `summary-boundary.ts`, alongside where it's detected — not a reason/variant of `StagnationLimitError`, which is specifically about loop/stagnation semantics).

`boundaryAwareTrim` gains a `threadId?: string` parameter (both call sites already have `thread_id` on `runtime.configurable`, the same place `model-input-snapshot.middleware.ts` and `recursion-guard.middleware.ts` already read it from). Without a `threadId` (defensive — shouldn't happen in production), recovery still truncates but with a plain, non-retrievable `[N chars omitted — no thread to offload to]` marker instead of a real stub.

See ADR-0041 for why this recovers automatically instead of pausing to ask, the way `RecursionGuardMiddleware` does for step-limit/stagnation.

#### Escalation wiring

`createContextWindowMiddleware` gains an `escalationMode: 'interrupt' | 'throw'` option, mirroring `createRecursionGuardMiddleware`'s existing parameter, wired identically at every call site that already configures `createRecursionGuardMiddleware`'s own `escalationMode`: `buildChatAgent`, `buildWorkspaceChatAgent`, `buildTaskAgent` (`chat-agent.ts`), and the wiki-ingestion agent (`wiki-ingestion-agent.ts`) all use `'interrupt'`; `buildSubAgentAgent` (`chat-agent.ts`) uses `'throw'`.

- `'interrupt'` mode: catches `ContextBudgetExceededError` and fails the turn through the existing `failAssistant`/`errorMessageOf` pipeline (`docs/superpowers/specs/2026-09-08-chat-error-classification-design.md`), classified as the already-existing `context_length` category — no new error-category UI work needed. The raw detail (which tool output didn't fit, even after truncation) goes in the existing expandable raw-text toggle.
- `'throw'` mode: lets `ContextBudgetExceededError` propagate, caught by `task-execution.ts`'s existing catch chain and routed to `deliverSubAgentCompletion` — the same reporting path a cancelled or failed sub-agent run already uses for `StagnationLimitError`.

This case should be rare in practice: layer 2.2 below removes the single biggest source of oversized `ToolMessage` content before it ever reaches `boundaryAwareTrim`.

### 2.2 MCP tool output gets the same offload treatment as `web_fetch`

`mcpToolToLangChain` (`chat-agent.ts:273-285`) is the one chokepoint every MCP tool — including the `gateway__duckduckgo-mcp-fetch_content` calls that triggered #354's incident — passes through before being bound to an agent. Today it returns the raw stringified tool result with no size check at all, unlike `web_fetch` (`api/src/agents/tools/web-fetch.tool.ts`), which already offloads anything over `STUB_THRESHOLD_CHARS` (10,000 chars, `tool-stub.ts`) via `storeToolContent` + `toolStub()`.

`mcpToolToLangChain`'s executor gains the `config` parameter LangChain's `tool()` already supports (mirroring `web_fetch`'s `config?.configurable?.thread_id` read), and applies the same threshold check:

```ts
export function mcpToolToLangChain(t: RegisteredTool) {
  return tool(
    async (args: Record<string, unknown>, config) => {
      const result = await t.execute(args);
      const text = typeof result === 'string' ? result : JSON.stringify(result);

      const threadId = config?.configurable?.thread_id as string | undefined;
      if (env.chat?.mcpToolStub?.enabled !== false && text.length > STUB_THRESHOLD_CHARS && threadId) {
        const toolKey = /* same randomBytes(4) pattern web_fetch.tool.ts uses */;
        storeToolContent(threadId, toolKey, text);
        return toolStub(
          { tool: t.boundName, chars: text.length, key: toolKey, threadId },
          [{ name: 'preview', content: text.slice(0, 1000) }],
        );
      }
      return text;
    },
    { name: t.boundName, description: t.description, schema: t.parameters },
  );
}
```

Unlike `web_fetch`, a generic MCP tool result carries no title/description/outline to build a richer stub from — the stub is a plain truncated preview (first ~1000 chars) plus the standard `toolStub()` retrieval frontmatter. `get_tool_key`'s tool description (`get-tool-key.tool.ts`) gets a one-line addition naming MCP tool output as another producer — no behavior change there, since it already reads `threadId`/`toolKey` generically off any stub's frontmatter.

### 2.3 User-configurable budget

`chat.contextWindow.maxTokens` becomes editable from the Model Providers settings page, in the same card as Default Provider — see ADR-0042 for why the config stays under `agent-behavior`/`ChatSchema.contextWindow` while the UI renders it elsewhere. No backend schema or route change is needed for `maxTokens` itself: the `agent-behavior` slug (`settings.handlers.ts:440-452`) already PATCHes `chat: ChatSchema.partial().optional()` generically.

`model-providers-panel.tsx` gains:

- A `maxTokens` number field in the Default Provider card, backed by a **second, independent call to the existing `useSettingsSection('agent-behavior')` hook** (`ui/src/pages/settings/use-settings-section.ts`) inside `model-providers-panel.tsx` — alongside its existing `useSettingsSection('model-providers')` call for the rest of the page. `setField('contextWindow.maxTokens', value)` and that hook's own `save()` are used exactly as `agent-behavior-panel.tsx` already uses them for its sibling `chat.*` fields.
- **Why this matters, not just where:** `agent-behavior`'s backend `write()` (`settings.handlers.ts:463`) merges `chat` only one level deep — `{ ...env.chat, ...data.chat }`. A PATCH body carrying only `{ chat: { contextWindow: { maxTokens } } }` would replace the *entire* `contextWindow` object, silently resetting `enabled`/`safetyMarginPct` to their schema defaults. `useSettingsSection` avoids this by construction — `save()` always PATCHes the full current section state (fetched whole, mutated via a deep-cloned `setField`), never a single isolated leaf — so this is only a risk if a future change hand-rolls a one-off fetch/PATCH for just this field instead of reusing the hook.
- `safetyMarginPct` and `enabled` are **not** exposed in this UI — they stay config-file-only (calibration/escape-hatch knobs, not something a user tunes day to day).

`ContextWindowSchema.maxTokens` gains a `.min(4000)` validation floor (double `MIN_BUDGET_FLOOR`, leaving headroom for a small tool set) — rejecting a value that would make this feature unable to do anything useful, enforced both client-side (immediate feedback) and server-side (the existing Zod `patchSchema` validation in `settings.handlers.ts`, which already rejects invalid PATCH bodies with field errors).

---

## 3. Config changes

```ts
// api/src/config/env.ts
export const McpToolStubSchema = z.object({
  enabled: z.boolean().default(true),
});

export const ChatSchema = z.object({
  // ...existing fields...
  mcpToolStub: McpToolStubSchema.optional(),
});

export const ContextWindowSchema = z.object({
  enabled: z.boolean().default(true),
  maxTokens: z.number().min(4000).default(32000), // was z.number().default(32000)
  safetyMarginPct: z.number().default(0.85),
});
```

`mcpToolStub` needs no new settings slug — it's picked up automatically by the existing `agent-behavior` slug's `chat: ChatSchema.partial().optional()` patch schema, the same way `contextWindow` already is.

---

## 4. Error handling / edge cases

- **Turn Overflow fully recoverable by truncation** (the common case): silent, automatic — no error, no interrupt. The reply proceeds normally; a truncated tool result is retrievable later via `get_tool_key` if the model needs it.
- **Turn Overflow not recoverable even at minimal stub size**: `ContextBudgetExceededError`, handled per §2.1's escalation wiring. Logged at `warn` (matching `MIN_BUDGET_FLOOR`'s existing treatment) in addition to being surfaced to the user/caller — this case means the configured ceiling genuinely cannot be honored for this tool set, a config problem worth being loud about on both sides.
- **No `threadId` available for offload** (defensive edge case, not expected in production): recovery still truncates to make the Turn fit, but with a plain non-retrievable marker instead of a real `toolStub()` — truncation must never fail just because offload storage isn't reachable.
- **`chat.contextWindow.enabled === false`**: both `beforeModel` and `wrapModelCall` already early-return before calling `boundaryAwareTrim` at all (`chat-agent.ts:211`, `:230`) — this fix's recovery path is simply never reached in that mode, same as today. No special-casing needed.
- **`mcpToolStub.enabled === false`**: `mcpToolToLangChain` returns the raw result unconditionally, same as today's behavior — Turn Overflow recovery (§2.1) remains the only safety net in that configuration.

---

## 5. Relationship to #353

This design assumes #353 (duplicate MCP-gateway tool execution) may never land, or could resurface in a different form — it is not a dependency. A single legitimate large tool output (a big wiki page, a long file read, one large web fetch) is sufficient to trigger Turn Overflow on its own; #353 only made it easier to hit on the incident thread.

---

## 6. Out of Scope

- **Per-model-aware automatic budget scaling** (varying `maxTokens` by the bound model's real context window rather than one flat global default) — a real gap (`chat.contextWindow` is a single config value shared across every provider/model today), but a separate, untracked future idea. §2.3's user-configurable `maxTokens` is a manual lever for this, not an automatic one.
- **`safetyMarginPct` / `contextWindow.enabled` in the Settings UI** — stay config-file-only.
- **Real per-provider token counting** — unaffected by this design; inherited out-of-scope note from #127.
- **Fixing #353 itself** — tracked separately; see §5.

---

## 7. Testing

Per the repo's testing conventions (root `AGENTS.md`):

- **Unit (`api/src/agents/summary-boundary.test.ts`)**: `boundaryAwareTrim` preserves the current Turn via truncation when the plain `trimMessages` fallback would otherwise return an anchorless/empty result; truncation selects the largest `ToolMessage` first and stops as soon as the Turn fits; truncated content round-trips through `storeToolContent`/`getToolContent` under the same `threadId`/`toolKey` the stub advertises; throws `ContextBudgetExceededError` when even fully-stubbed content doesn't fit; falls back to a non-retrievable marker when no `threadId` is given.
- **Unit (MCP tool wiring, likely `chat-agent.test.ts`)**: `mcpToolToLangChain` stubs output over `STUB_THRESHOLD_CHARS`, passes through unchanged below it, respects `mcpToolStub.enabled === false`, and reads `threadId` from the tool's `config` parameter.
- **Orchestration (`chat-agent.test.ts` / existing recursion-guard-style integration test)**: `createContextWindowMiddleware`'s `escalationMode` dispatches `ContextBudgetExceededError` to the error-classification path in `'interrupt'` mode and lets it propagate in `'throw'` mode, matching the existing `RecursionGuardMiddleware` test pattern (`recursion-guard.middleware.test.ts`, `loop-guard.integration.test.ts`).
- **UI (Jest, `ui/test/`)**: `model-providers-panel.tsx` renders the `maxTokens` field from `agent-behavior`'s GET response and submits it via its own PATCH call, independent of the panel's existing `model-providers` save flow.
- **Backend handler (`settings.handlers.test.ts`)**: PATCH `agent-behavior` accepts and persists `chat.mcpToolStub` and rejects a `contextWindow.maxTokens` below the new `4000` floor with a field error.
