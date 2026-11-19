# History Compaction Middleware — Design

**Date:** 2026-11-19
**Status:** Approved
**Issue:** [#403 — Agent loop has no mid-turn context compaction, so long tool-call chains die at a hard context-budget wall](https://github.com/tkottke90/amazing-hashbrown/issues/403)
**Related:** [#127 — Context-window trimmer doesn't keep chat threads under configured token ceiling](https://github.com/tkottke90/amazing-hashbrown/issues/127) (closed), [#354 — Context-window trim drops entire turn, including user message, when it can't fit budget](https://github.com/tkottke90/amazing-hashbrown/issues/354) (closed; this design builds directly on its recovery machinery), [#361](https://github.com/tkottke90/amazing-hashbrown/issues/361), [#369](https://github.com/tkottke90/amazing-hashbrown/issues/369)
**Reference:** `docs/Design/react-agent-middleware-order.html` — diagrams of the existing middleware construction/order this design slots into
**ADRs:** [0041](../adr/0041-turn-overflow-recovers-via-truncation-not-interrupt.md), [0042](../adr/0042-context-budget-config-lives-in-agent-behavior-renders-in-model-providers.md) (both inherited unchanged — see §4)

---

## 1. Problem & Goal

Within a single turn, the ReAct loop's own tool-call/model round trips accumulate raw `ToolMessage` history with nothing proactively shrinking it. `ContextWindowMiddleware` (`chat-agent.ts`, `summary-boundary.ts`) already trims and, per #354, recovers from Turn Overflow by truncating the largest `ToolMessage` to a retrievable stub — but both of its hooks are purely **reactive**: they do nothing until the running total already exceeds the configured budget, and recovery is a byte-size cut, not a content-aware one. One real turn reached 586,799 tokens against a 32,000-token budget before it ever hit that reactive path.

**Goal:** add a proactive step inside the loop that condenses older tool results into short LLM-generated summaries once a turn is heading toward its budget, well before the reactive trim/stub/`ContextBudgetExceededError` path has to do anything. The existing trim and Turn Overflow recovery stay exactly as they are — they become the backstop for whatever this step didn't (or couldn't) handle, not a mechanism being replaced.

---

## 2. Design

### 2.1 New middleware, and where it sits

A new `historyCompactionMiddleware`, with a single `beforeModel` hook (no `wrapModelCall` stage — it only needs to mutate the persisted message list once per loop pass, not anything call-scoped). It's added to all four agent builders (`buildChatAgent`, `buildWorkspaceChatAgent`, `buildTaskAgent`, `buildSubAgentAgent` — `chat-agent.ts`), in each one's middleware array **immediately before** that builder's `createContextWindowMiddleware(...)` entry. Concretely: 5th of 6 `beforeModel`-stage entries in the Chat/Workspace Chat/Task tuple, 3rd of 4 in the Sub-agent tuple (see the reference diagram above for the full ordering).

Because `beforeModel` fires once per loop iteration — before every `model.invoke()` call in the turn, not once per turn — this middleware gets a chance to act on every pass, the same way `ContextWindowMiddleware`'s own `beforeModel` stage already does.

Each time it fires:

1. Estimate the turn's current token count via `estimateTokens` (the same cheap char-based heuristic `ContextWindowMiddleware` already uses — no new counting logic).
2. If under the proactive threshold (§2.2), return `undefined` — no-op, same convention `ContextWindowMiddleware` uses when already under budget.
3. If over threshold, select eligible candidates (§2.3).
4. If no candidates are eligible, return `undefined` — a no-op, not an error (e.g. a turn made of many small tool calls where nothing is actually big enough to be worth compacting).
5. For each eligible `ToolMessage`, synchronously summarize and replace its content in place (§2.4–2.6).
6. Return `{ messages: updatedMessages }` so the change is persisted to the checkpoint — matching `ContextWindowMiddleware`'s own `beforeModel` stage, and meaning `ContextWindowMiddleware`'s subsequent trim stage (next in the array) always sees the already-compacted history.

### 2.2 Trigger: proximity to budget

Compaction only runs once `estimateTokens(state.messages) > contextWindow.maxTokens * historyCompaction.thresholdPct`. This mirrors how `safetyMarginPct` already scales the trim ceiling down defensively — here it scales a separate, lower threshold up from zero, so compaction only engages once a turn is actually heading toward trouble, never on short turns.

### 2.3 Eligibility

Candidates are selected by a pure, independently unit-testable function, `selectCompactionCandidates(messages)`:

1. Isolate the current turn: `messages.slice(lastHumanMessageIndex)` — the same helper shape `summary-boundary.ts` already has (`findLastIndex` + `isHumanMessage`).
2. Find the last `AIMessage` with `tool_calls` in that slice; its paired `ToolMessage`(s) are the most recent tool-call round and are **protected** — never eligible, regardless of size or budget pressure, so the model's immediate working context always stays verbatim.
3. Of what remains, a `ToolMessage` is eligible only if:
   - it is **not already tagged** as compacted (§2.6), and
   - its content exceeds `STUB_THRESHOLD_CHARS` (10,000 characters, `tool-stub.ts`) — the same size this app already treats as "too large to return inline" for `web_fetch`/MCP tool results, reused here rather than introducing a second notion of "large." Summarizing a two-line tool result would waste a model call for no benefit.

### 2.4 The summarization call

One `model.invoke()` per eligible `ToolMessage` (not one batched call) — each failure is isolated to the message it was summarizing, and the prompt/response shape stays a plain string in, plain string out, with nothing to parse apart.

- **Model:** a separately configurable summarizer provider/model (`historyCompaction.summarizerProvider`/`summarizerModel`), falling back to the turn's own provider/model when unset — same `resolveTurnModel` fallback pattern `workspace-summarizer.ts` and `exhausted-run-summarizer.ts` already use.
- **Input cap:** the original content is capped to `historyCompaction.maxSourceChars` before being sent to the summarizer (same idea as `workspace-summarizer.ts`'s `MAX_SUMMARY_TRANSCRIPT_CHARS`) — summarizing one enormous tool result must not itself blow out the summarizer call's own context.
- **Prompt:** instructs the model to condense one tool call's result for continuity within an ongoing agent turn, given the tool's name and its (capped) content. No tool harness, no structured output — a single plain `model.invoke(prompt)`, same shape as `maybeSummarizeWorkspace`'s model call.

### 2.5 Persistence & retrievability

The original content is never silently lost. Before replacing a `ToolMessage`'s content:

1. `storeToolContent(threadId, toolKey, originalContent)` — the exact function `truncateToolMessage` (`summary-boundary.ts`) already calls.
2. The replacement content is built with the existing `toolStub()` helper (reused, not reimplemented): the LLM summary as its body section, plus a note pointing at `get_tool_key` so the model can still retrieve the original in full if the summary turns out to be insufficient.
3. `tool_call_id`, `name`, and `id` are copied from the original untouched — the message is never dropped, only its content is rewritten, preserving the tool-call/tool-result pairing every provider API requires.

No `threadId` on `runtime.configurable` (defensive — shouldn't happen at either real call site) means compaction is skipped entirely for that pass, rather than offloading to nowhere.

### 2.6 Idempotency

A replacement `ToolMessage` is tagged the same way `isSummaryBoundary` already tags workspace-summary markers (`summary-boundary.ts`):

```ts
const HISTORY_COMPACTION_KIND = 'history-compaction';

export function isHistoryCompacted(message: BaseMessage): boolean {
  const tag = message.additional_kwargs?.['hashbrown'] as { kind?: string } | undefined;
  return tag?.kind === HISTORY_COMPACTION_KIND;
}
```

The tag is merged into `additional_kwargs`, never overwrites it (`{ ...original.additional_kwargs, hashbrown: { kind: HISTORY_COMPACTION_KIND, toolKey } }`) — `truncateToolMessage` already copies `additional_kwargs` wholesale when it replaces content, and this must not clobber anything else already stored there. `selectCompactionCandidates` (§2.3) calls `isHistoryCompacted` to skip anything already compacted, so a later pass in the same turn never re-summarizes an already-short summary.

### 2.7 Relationship to `ContextWindowMiddleware`

Unchanged. `createContextWindowMiddleware`'s two trim stages run exactly as they do today, immediately after this middleware in the array — they're the backstop, not a competing mechanism. If compaction fully solved the budget pressure, the trim stages are no-ops that pass through unchanged input, same as always. If compaction did less than needed (nothing eligible, a summarizer call failed, summaries still too large), the existing trim → Turn Overflow recovery → `ContextBudgetExceededError` path is untouched and still catches it.

---

## 3. Config changes

New sibling section under `env.chat`, parallel to the existing `contextWindow` and `workspaceSummary` — a new named behavior gets its own named config section rather than growing `ContextWindowSchema`'s field list with unrelated knobs:

```ts
// api/src/config/env.ts
export const HistoryCompactionSchema = z.object({
  enabled: z.boolean().default(true),
  thresholdPct: z.number().min(0).max(1).default(0.6),
  summarizerProvider: z.string().optional(),
  summarizerModel: z.string().optional(),
  maxSourceChars: z.number().min(1000).default(16000),
});

export const ChatSchema = z.object({
  // ...existing fields...
  historyCompaction: HistoryCompactionSchema.optional(),
});
```

Exposed as `env.chat.historyCompaction`. `createHistoryCompactionMiddleware(contextWindowCfg, historyCompactionCfg)` takes both — the trigger threshold (§2.2) is a percentage of `contextWindow.maxTokens`, so the factory needs both config objects, not just its own. `enabled` defaults to `true` (this fixes a live production crash; shipping it off by default would leave #403 live until someone opts in — matching how `contextWindow` and `workspaceSummary` already ship enabled). `enabled` is independently toggleable from `contextWindow.enabled`, so trimming can stay on even if LLM-based compaction is turned off.

No new settings-UI slug is needed — like `mcpToolStub` before it, this is picked up automatically by the existing `agent-behavior` slug's `chat: ChatSchema.partial().optional()` patch schema.

---

## 4. Error handling / edge cases

- **Per-message summarization failure** (provider error, timeout): logged at `warn`, that one `ToolMessage` is left untouched, and the pass continues to the next candidate. Never throws out of `beforeModel` — matching `workspace-summarizer.ts`'s own "must never throw" discipline. Worst case, compaction does less than it could this pass; the existing trim/stub backstop (§2.7) still catches whatever's left.
- **No eligible candidates**: no-op, not an error — e.g. a turn over budget purely from small tool calls, where nothing meets the minimum-size floor (§2.3).
- **No `threadId` available**: compaction skipped entirely for the pass (§2.5) — truncation-style recovery never fails just because offload storage isn't reachable, and this middleware shouldn't either.
- **`historyCompaction.enabled === false`**: the `beforeModel` hook early-returns before doing anything, same convention `ContextWindowMiddleware` uses for its own `enabled` flag.
- **Sub-agent runs**: unaffected by the Sub-agent tuple's missing `afterAgent` stage (ADR-0063) — this middleware only ever needs `beforeModel`, which the Sub-agent tuple has.
- **Already-compacted content re-entering a later pass**: skipped via the idempotency tag (§2.6) — never re-summarized, never re-offloaded under a second `toolKey`.

---

## 5. Out of Scope

- **Batching multiple `ToolMessage`s into one summarization call.** Considered (a single `model.invoke()` returning a structured per-message array), rejected in favor of one call per message — simpler prompt/response shape, and a failure in one message's summarization can't affect any other's.
- **Cheap, non-LLM heuristic compaction as the primary mechanism** (bigger stubs, proactively, instead of LLM summarization). Considered as the headline approach, rejected — the existing truncate-to-stub path already does this as a last resort (§2.7); the actual gap #403 identifies is the lack of _content-aware_ condensation, which only an LLM summary provides.
- **A hybrid "cheap first, LLM fallback" trigger.** Considered, rejected in favor of a single, simpler proactive-threshold trigger (§2.2) directly on an LLM summarization step.
- **Protecting more than the single most recent tool-call round**, or gating eligibility by a configurable iteration-age window instead of just "not the latest round." The simpler rule was preferred; revisit only if real usage shows the model needs more than one round of verbatim recent history.
- **A GLOSSARY.md entry for "History Compaction."** This design reuses existing glossary terms (Turn, Turn Overflow) without coining a new one; adding a formal term is a reasonable follow-up, not required for this change.
- **Changing `RecursionGuardMiddleware`'s limits or `ContextWindowMiddleware`'s trim/recovery behavior itself.** Both are untouched — this design only adds a new middleware ahead of the existing ones in the array.

---

## 6. Testing

Per the repo's testing conventions (root `AGENTS.md`):

- **Unit (new `api/src/agents/history-compaction.middleware.test.ts`, or alongside `summary-boundary.test.ts` if `selectCompactionCandidates`/`isHistoryCompacted` live there):**
  - `selectCompactionCandidates` excludes the most recent tool-call round, excludes already-tagged messages, excludes content under the minimum-size floor, and isolates to the current turn via the last `HumanMessage` — fake message arrays in, exact candidate array out, no model involved.
  - `isHistoryCompacted` detects the tag correctly and doesn't false-positive on an untagged message or one carrying unrelated `additional_kwargs`.
  - The threshold check triggers/doesn't trigger at the boundary, given a fake `estimateTokens` and config.
- **External-orchestration (mocked model):**
  - Outbound: the summarizer prompt carries the tool name and the (capped) original content, capped at `maxSourceChars`.
  - Inbound: success replaces content, calls `storeToolContent`, tags via `isHistoryCompacted`; a per-message failure leaves that message untouched, logs a warning, and doesn't stop the rest of the pass.
- **Orchestration (`chat-agent.test.ts`, alongside the existing `context-window.integration.test.ts` pattern):** the full `beforeModel` hook wired up — confirms `createContextWindowMiddleware`'s subsequent trim stage operates on the already-compacted (smaller) message list, not the original, when both are present in the same builder's middleware array.
- **Eval (AGENTS.md EDD rule 1 — required before implementation, not a spec-time deliverable):** a failing eval scenario exercising a long tool-call chain where the final answer depends on information from an early tool result that will have been compacted by the time the model answers, authored via `npm run eval:new`. The exact suite/scenario is left to implementation time, per EDD's own process.

---
