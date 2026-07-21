# System Prompt Template — Design

**Date:** 2026-07-20
**Status:** Approved (design)
**Related:** [`docs/superpowers/specs/2026-07-20-wiki-locate-and-orient-tools-design.md`](2026-07-20-wiki-locate-and-orient-tools-design.md) — this work exists because manual testing of that feature raised gap #3: whether the agent organically chains `wiki_locate` → `wiki_orient` → `wiki_search`/`wiki_read_page` on its own, with no seeded history.

## Purpose

The chat agent (`buildChatAgent` in `api/src/agents/chat-agent.ts`) runs today with **no system prompt at all** — `createAgent({ model, tools, checkpointer, middleware })` passes nothing for the `systemPrompt` option. Every steering signal the model gets comes from four independent, per-tool `description` strings, which it reads in isolation rather than as a coherent strategy. That's a plausible reason organic tool-chaining is inconsistent: a capable model might infer the intended locate → orient → search/read sequence from the descriptions alone, but there's nothing establishing it as an explicit strategy, and `wiki_search` alone already answers most single-domain queries — the rational shortcut for a model with no other guidance.

This introduces a small, code-level system prompt template — a harness-authored base layer, composable with an (currently unwired) user-instructions layer — and wires it into the chat agent. Its first content is scoped narrowly to wiki tool-navigation guidance, the exact gap that motivated this work.

## Scope note: this also surfaces and fixes an eval-tooling gap

While designing how to _test_ this change, two pre-existing gaps in the evaluation harness surfaced:

1. **The eval harness never includes a system prompt.** `lib/evaluations/src/runner.ts`'s `tool-call`/`tool-sequence` execution paths (`invokeToolCallModel`) invoke the model with only the scenario's raw input or seeded messages — no `SystemMessage`, ever. Without a fix, new eval scenarios would test the same no-system-prompt behavior as today, proving nothing about this change.
2. **`bin/eval.ts`'s `evalTools` array never included `wikiLocateTool`/`wikiOrientTool`** — a defect from the earlier wiki-locate-and-orient-tools work, caught only now. Every existing `wiki-navigation.yaml` scenario that expects the model to call `wiki_locate` or `wiki_orient` has been silently unrunnable — the model was never given those tools to choose from, so `runToolCall`/`runToolSequence` would report `toolCalled: null` for all of them.

Both are fixed as part of this same unit of work, since fixing #1 requires touching the same files, and #2 is a prerequisite for any of the new or existing wiki-navigation scenarios to mean anything when run.

## In scope

- `api/src/agents/system-prompt.ts` — new module: `buildSystemPrompt(userInstructions?: string): string`, composing a harness base with an optional user-instructions block.
- Wiring `buildSystemPrompt()` into `chat-agent.ts`'s `createAgent({...})` call via the `systemPrompt` option.
- `lib/evaluations/src/runner.ts`: optional `systemPrompt?: string` on `RunConfig`, prepended as a `SystemMessage` for `tool-call` and `tool-sequence` scenario execution only.
- `bin/eval.ts`: add `wikiLocateTool`/`wikiOrientTool` to `evalTools` (bugfix), and pass `buildSystemPrompt()`'s output as `config.systemPrompt`.
- New scenarios in `suites/wiki-navigation.yaml` using natural, non-leading phrasing to test organic (non-seeded) first-tool-call behavior, in both directions (calls `wiki_locate` when genuinely ambiguous; does _not_ over-call it when the domain is already obvious).
- `TODO_LIST.md`: note this addition against the existing "Wiki Locate & Orient Tools" completed entry, and add a new Outstanding Item for the broader agent-behavior-baseline follow-up.

## Out of scope

- Wiring the user-instructions slot to any real source (config.yaml, a per-thread setting, etc.) — stays an unwired placeholder parameter. A later, separate decision.
- Broadening the harness prompt beyond wiki tool-navigation — general tone/identity/formatting baseline is the new Outstanding Item, deliberately deferred so it gets its own design pass and heavier eval investment.
- Adding `systemPrompt` support to `deterministic`/`semantic`/`llm-judge`/`structured`/`human` scenario types — only `tool-call`/`tool-sequence` need it to prove this change; extending further is unnecessary scope right now.
- Any change to `WikiRegistry`/`LlmWiki` or the wiki tools themselves.

## Component: `system-prompt.ts`

**File:** `api/src/agents/system-prompt.ts`

```ts
export function buildSystemPrompt(userInstructions?: string): string {
  if (!userInstructions?.trim()) return HARNESS_PROMPT;
  return `${HARNESS_PROMPT}\n\n---\n\nAdditional instructions from the user on how to behave:\n${userInstructions.trim()}`;
}
```

**`HARNESS_PROMPT` content** (scoped to wiki tool-navigation only):

```
You have access to a multi-domain knowledge base (a wiki) through four tools:

- wiki_locate: find which domain applies to a topic, or list all domains when you don't have one in mind yet.
- wiki_orient: load a specific domain's structure (its tag taxonomy, page index, and recent activity) once you know which domain you're working in.
- wiki_search: find specific pages by content across every domain.
- wiki_read_page: read a specific page's full content once you've found it.

When you don't already know which domain applies, call wiki_locate first. Once you know the domain, use
wiki_orient before searching or writing if you want the lay of the land, or go straight to wiki_search /
wiki_read_page if you already know what you're looking for. Don't repeat a step you don't need — if the
domain is already obvious or was established earlier in the conversation, skip wiki_locate and search directly.
```

No caller passes `userInstructions` yet — `buildChatAgent()` calls `buildSystemPrompt()` with no argument. The parameter and composition logic exist now so wiring a real source later is a one-line change at the call site, not a redesign.

**Wiring:** `chat-agent.ts` imports `buildSystemPrompt` and adds `systemPrompt: buildSystemPrompt()` to the existing `createAgent({...})` call in `buildChatAgent`.

**Testing:** unlike the wiki tools, this is a pure function with no I/O — genuinely unit-testable. New `api/src/agents/system-prompt.test.ts`:

- returns harness-only content with no arguments
- returns harness-only content for an empty or whitespace-only `userInstructions`
- appends a clearly delimited user-instructions block for real input, with the harness content still present unmodified

## Component: eval harness `systemPrompt` support

**File:** `lib/evaluations/src/runner.ts`

- Add `systemPrompt?: string` to `RunConfig`.
- In the `tool-call` branch of `executeScenario`: when `config.systemPrompt` is set, invoke with `[new SystemMessage(config.systemPrompt), new HumanMessage(s.input)]` instead of the bare `s.input` string.
- In the `tool-sequence` branch: prepend a `SystemMessage(config.systemPrompt)` ahead of the messages `buildSeededMessages` already constructs (still starting with the seeded conversation's `HumanMessage`, then the seeded tool-call/result pairs).
- No other scenario types are touched — `deterministic`/`semantic`/`llm-judge`/`structured`/`human` scenario execution is unchanged.

## Component: `bin/eval.ts` wiring

- **Bugfix:** add `wikiLocateTool` and `wikiOrientTool` to the `evalTools` array (currently missing — see Scope note above), matching the production `chat-agent.ts` tool list minus MCP tools, consistent with the existing comment explaining that exclusion.
- Import `buildSystemPrompt` from `../api/src/agents/system-prompt.js` (same cross-workspace import pattern already used for `provider-factory.ts`, `env.ts`, and the tool files) and pass `config.systemPrompt: buildSystemPrompt()` into the `runEval({...})` call, so eval runs exercise the real production prompt rather than a parallel copy that can drift from it.

## Component: new `suites/wiki-navigation.yaml` scenarios

Additive to the six existing scenarios (`wnav-001` through `wnav-006`, which remain unchanged and now become actually runnable once the `bin/eval.ts` bugfix lands). New scenarios, using natural phrasing rather than `wnav-001`'s deliberately explicit "which part of the knowledge base should I check" wording:

- **Organic locate-first, genuinely ambiguous topic** (`tool-call`): a query that could plausibly belong to either the `user` or `self` domain (e.g. something touching "growth," which appears in both domains' routing signals in spirit), checking the model's first call is `wiki_locate` — proof the harness prompt actually steers behavior on live, unseeded input, not just seeded continuations.
- **No over-calling on an obvious topic** (`tool-call` or `llm-judge`): a query unambiguously about one domain, checking the model does _not_ call `wiki_locate` first (or scores the response for going straight to a reasonable next step) — proof the prompt's "skip it when obvious" instruction actually prevents the overcorrection we were worried about.

Exact scenario wording and pass criteria are finalized during implementation, since natural-language phrasing that reliably reads as "ambiguous" vs. "obvious" to a live model benefits from a little empirical iteration rather than being locked down in the spec.

## `TODO_LIST.md` updates

- Append a short note to the existing "Wiki Locate & Orient Tools" completed-item entry (Section 3) mentioning: the system prompt addition, the `bin/eval.ts` tool-registration bugfix, and the eval harness's new `systemPrompt` support.
- Add a new Outstanding Item at the top of the list: **"Agent Behavior Baseline (System Prompt)"** — broadens `system-prompt.ts`'s `HARNESS_PROMPT` beyond wiki-navigation into general tone/identity/formatting, informed by real usage; explicitly expected to exercise the evaluation system heavily. Existing Outstanding Items renumber down by one, and any numeric dependency references shift accordingly (mirroring how the original Wiki Orient Tool removal was handled).

## Testing summary

| Component                                     | Test approach                                                                                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `system-prompt.ts`                            | New unit tests (pure function — genuinely testable, unlike the wiki tools)                                                                                                                              |
| `runner.ts`'s `systemPrompt` support          | Existing `lib/evaluations` test suite gets cases confirming a `SystemMessage` is prepended for `tool-call`/`tool-sequence` when `systemPrompt` is set, and that behavior is unchanged when it's omitted |
| `bin/eval.ts` changes                         | No unit tests (CLI script, matches existing convention — the file has none today); verified by actually running `npm run eval -- --suite wiki-navigation` against a live model                          |
| New/existing `wiki-navigation.yaml` scenarios | Run via `npm run eval`, not CI (no CI job runs `npm run eval` today — this remains a manual verification step, same limitation already documented in the wiki-locate-and-orient-tools spec)             |

## Open items deferred to later work

- Wiring the user-instructions slot to a real source.
- The broader agent-behavior-baseline content (new TODO_LIST item).
- Adding a CI job that actually runs `npm run eval` — still a known, separate gap, unaffected by this change.
