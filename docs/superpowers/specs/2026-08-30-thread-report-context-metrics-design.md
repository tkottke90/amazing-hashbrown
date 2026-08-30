# Thread Report Context/Recursion Tuning Metrics — Design

**Date:** 2026-08-30
**Status:** Approved
**Issue:** [#112 — Add context/recursion tuning metrics to Thread Report](https://github.com/tkottke90/amazing-hashbrown/issues/112)

---

## 1. Problem & Goal

The Thread Report (`lib/thread-reports`, generated via `npm run thread-report -- --thread <id>`) is used to tune agent behavior, but it currently gives no visibility into two things that matter for tuning:

- How close a thread is to the recursion limit (`env.agent.recursionLimit`, enforced by `api/src/agents/recursion-guard.middleware.ts`).
- How the context window is being managed — how big the thread's full history is, how much of it the model would actually see on the next turn, and how much of that is system-prompt overhead.

This design adds four observability-only additions to the report: a turn/step index on each LLM message, a Total/Active Context Size snapshot with a visual boundary marker in the conversation, and per-trace system-prompt token counts. **No agent behavior changes.** All work is contained to `lib/thread-reports` plus one small shared-utility extraction; nothing in the live chat pipeline (`chat-agent.ts`, `contextWindowMiddleware`, `observability-handler.ts`, stream-handlers, or the DB schema) changes.

---

## 2. Shared Token Estimator

Today `api/src/agents/chat-agent.ts` and `api/src/agents/observability-handler.ts` each carry their own private `estimateTokens` (4 chars ≈ 1 token heuristic), used respectively by the context-window trimmer and as a fallback when a provider doesn't return `usage_metadata`.

Both are consolidated into one exported function in `@tkottke90/llm-common-types` (a new export path, e.g. `llm-common-types/tokens`) — already a dependency of `api`, `lib/observability`, and `lib/thread-reports`, making it the natural common home without adding new cross-package coupling:

```typescript
// lib/llm-common-types/src/tokens/index.ts
// Rough estimate: 4 characters ≈ 1 token. Good enough for relative/tuning
// comparisons (context-window trimming, this estimate's other two call
// sites, and the Thread Report's context-size metrics) — not for
// billing-accurate counts.
//
// TODO(tokenizer): if per-model accuracy is ever needed, swap this
// implementation for a real tokenizer (e.g. tiktoken) behind this same
// signature — every call site below takes text/BaseMessage[] in, a number
// out, so no caller needs to change.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

`chat-agent.ts` and `observability-handler.ts` switch to importing this instead of keeping their own copies; `lib/thread-reports` becomes a third consumer. Existing tests referencing the old private copies (`chat-agent.test.ts`, `observability-handler.test.ts`) are updated to import the shared one rather than deleted.

---

## 3. Turn / Step Index

Each `assistant`-kind message in the Conversation section gets a badge showing its cumulative position in the thread, e.g. **"Step 47 / 100"** — the same count `recursion-guard.middleware.ts` checks (`state.messages.filter(isAIMessage).length`, checked against `env.agent.recursionLimit`, default 100). Because the LangGraph checkpointer persists `state.messages` per-thread (not reset per user turn), this count is cumulative across the whole thread's lifetime, not per individual exchange.

Computed in `build.ts`, no new instrumentation: walk `thread.messages` in `seq` order, incrementing a counter each time `kind === 'assistant'` is encountered, and attach that running count to the message record before it reaches the template. `env.agent.recursionLimit` and `env.agent.recursionWarnThreshold` (both already resolvable in-process, since `bin/thread-report.ts` runs inside the `api` config context) are passed to the template so it can render "of 100" and visually flag steps past the warn threshold.

---

## 4. Total / Active Context Size & the Context-Window Boundary Marker

Per the approved approach, this is computed **at report-build time** by replaying the same budget logic `contextWindowMiddleware` uses — not by adding new capture to the live chat pipeline, and not by literally calling LangChain's `trimMessages()` (which operates on real `BaseMessage` objects; the report only has `ThreadReportMessageRecord`s, a different, intentionally-decoupled shape that also includes kinds — `hitl_prompt`, `wiki_update` — that were never part of LLM state).

`build.ts` implements a self-contained **budget walk** over only the message kinds that were ever part of the LLM's actual message state — `user`, `assistant`, `tool_call` (each `tool_call` record already carries both the call and its result, so there's no separate result record that could be split off), and `summary`. `hitl_prompt` and `wiki_update` are side-channel/UI records (an interrupt prompt, an async wiki-write event) that were never sent to the model, so they're excluded from both the token totals and the walk's message-to-message stepping, though they still render in their existing place in the Conversation section.

The walk: iterate the counted messages newest → oldest, accumulating `estimateTokens` per message, stopping once the running total would exceed the configured budget (`env.chat.contextWindow.maxTokens`, default 32000) — then step forward to the nearest preceding `user`-kind message, mirroring `contextWindowMiddleware`'s `startOn: 'human'` rule.

This produces one thread-level snapshot (not a per-turn history, per the approved scope):

- **Total Context Size** — heuristic token estimate summed across every stored message in the thread.
- **Active Context Size** — heuristic token estimate of the tail the budget walk currently keeps.
- **`contextWindowMaxTokens`** — the budget used, surfaced for context.
- **`boundaryMessageId`** — the id of the oldest message the budget walk kept; `null` when Active equals Total (nothing would be trimmed).

These are added to `ThreadReportData` (exact placement — top-level vs. nested under `stats` — is an implementation detail for the plan). If the thread has zero messages, the block is omitted rather than showing zeros, to avoid implying trimming happened when it's actually indeterminate.

**Rendering:**
- `report.njk`'s summary/stats area (near `turnCount`/`toolCallCount`) gets a new "Context Window" block: Total vs. Active tokens and the fraction of budget in use.
- In the Conversation section, the message whose `id === boundaryMessageId` gets a visible divider rendered just above it (e.g. "── active context window begins here ──"), so a reader scrolling the conversation sees directly which messages the model would no longer see on the next turn.

---

## 5. System Prompt Token Count

Each "System Prompt" entry in the Trace section (`report.njk`'s `<details class="span-row">` block for `event.trace.systemPrompt`) shows its token count next to the label, e.g. **"System Prompt · 612 tokens"**.

Computed lazily in `build.ts` via `estimateTokens(trace.systemPrompt)` — the text is already stored per trace (`observability_traces.system_prompt`, set once at `startTrace()`), so no new capture is needed. Attached as a `systemPromptTokens: number | null` field alongside each `TraceTimelineEvent`, rather than computed inline in the Nunjucks template.

---

## 6. Testing

- **`@tkottke90/llm-common-types`**: unit tests for the extracted `estimateTokens` (moved logic, same behavior).
- **`lib/thread-reports` (`build.ts`)**, Mocha:
  - Step-index counting, including a synthetic thread with multiple tool-calling loops within a single turn, to catch any drift from the recursion guard's own counting logic.
  - Budget walk: nothing trimmed, one trim, budget landing exactly on a message boundary, and an empty thread.
  - System-prompt token attachment.
- No E2E coverage — this is a CLI/report-generation feature, not a UI flow; `e2e/AGENTS.md`'s Playwright suite doesn't apply.

---

## 7. Files Changed

| File | Change |
| --- | --- |
| `lib/llm-common-types/src/tokens/index.ts` (new) | Shared `estimateTokens` heuristic, with a `TODO(tokenizer)` comment marking where a real tokenizer would plug in later |
| `lib/llm-common-types/package.json` | Add `./tokens` export path |
| `api/src/agents/chat-agent.ts` | Remove private `estimateTokens`; import shared one |
| `api/src/agents/observability-handler.ts` | Remove private `estimateTokens`; import shared one |
| `api/src/agents/chat-agent.test.ts`, `api/src/agents/observability-handler.test.ts` | Update imports to the shared estimator |
| `lib/thread-reports/src/types.ts` | Add `systemPromptTokens` to `TraceTimelineEvent`; add step index to `ThreadReportMessageRecord` (or a parallel structure); add context-window snapshot fields to `ThreadReportData` |
| `lib/thread-reports/src/build.ts` | Step-index counting; budget-walk implementation (Total/Active Context Size, boundary message); system-prompt token attachment |
| `lib/thread-reports/templates/report.njk` | Render step-index badges on assistant messages; render the Context Window summary block; render the boundary-marker divider in the Conversation section; render system-prompt token counts |
| `lib/thread-reports/src/build.test.ts` (new or extended, matching existing test conventions) | Cover step-index, budget-walk, and system-prompt-token cases from §6 |

---

## 8. Out of Scope

- Any change to agent/chat behavior, `contextWindowMiddleware`, `observability_traces`, or the DB schema — this is a report-time computation over already-persisted data.
- A real tokenizer (e.g. tiktoken) — the heuristic estimate is reused per the approved decision; a `TODO(tokenizer)` comment marks the swap-in point (§2) for a future change.
- Per-turn history of Total/Active Context Size over time — only the current (latest) snapshot is shown.
- Any new UI page — the Thread Report remains a CLI-generated static HTML file.
