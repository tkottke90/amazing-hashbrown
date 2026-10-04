# Malformed Tool Call & Prose-Question Detection — Design

**Date:** 2026-10-03
**Status:** Draft
**Related:** [tkottke90/amazing-hashbrown#227](https://github.com/tkottke90/amazing-hashbrown/issues/227)

---

## Goal

Give the eval harness a way to tell "the model reasoned badly" apart from "the
model/provider pairing can't do structured tool calls here." Today both read
identically — `toolCalled: null, calledTools: []` — so a provider-level
transport problem (e.g. Lemonade/Ornith emitting `<tool_call>…</tool_call>`
as plain text instead of a structured call) gets misdiagnosed as a model
capability gap, and nobody can tell the difference without rerunning with
`DEBUG_LLM_HTTP` and reading raw output by hand.

This adds a shared detector for text-embedded tool calls and prose-form
clarifying questions, surfaces both as distinct, separately-reported failure
categories across every scenario type that can hit them, and ships a new
`provider-compatibility` suite that's the first thing to run against a new
model/provider.

---

## Problem

- `lib/evaluations/src/executors/tool-call.ts` (and `tool-sequence.ts`)
  derive `toolCalled`/`calledTools` purely from `AIMessage.tool_calls`. When a
  model instead writes the call as text — `<tool_call>…</tool_call>`,
  `<function=NAME>`, `<|tool_call|>`, a bare `<TOOL_NAME>…</TOOL_NAME>`, or a
  raw JSON `{name, arguments}` object — LangChain sees no tool call, the array
  is empty, and the result is indistinguishable from "the model declined to
  call anything."
- `llm-judge` scenarios bind no tools at all, so the same text-embedded shape
  just depresses the judge's score with no indication the output was ever a
  tool call. Confirmed on real runs: `wiki-search` `ws-002`/`ws-003` scored
  2/10 from the judge for exactly this reason.
- A related but distinct failure: a model asked an unambiguous
  clarification question answers in prose instead of calling `ask_user`
  (`calledTools: [], finish_reason: stop`). Seen consistently across
  `wiki-navigation`/`wnav-004` and `instruction-hierarchy`/`ih-002` on the
  same two providers. Same "provider/model limitation, not a prompt problem"
  signature as the text-embedded tool call, but a different shape (no
  tool-call syntax at all — just a question the model chose to ask in
  plain text).
- Both failures currently require a human to read raw `actualOutput` to
  recognize. A user evaluating a new model against this harness has no quick
  way to learn "this pairing can't do structured tool calls" versus "this
  model reasons badly here."

---

## Decisions (and why)

| #   | Decision                                                                                                                                                                                                                                                                            | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | One unified design covers both `malformed_tool_call` (text-embedded tool calls) and `prose_question` (prose instead of `ask_user`), plus the expanded shape list from the issue's follow-up comment.                                                                                | Both are the same root cause (provider/model can't reliably use structured output) surfacing through the same consumers (detector, result schema, CLI/HTML reporting, the new suite). Splitting them would duplicate all of that plumbing twice.                                                                                                                                                                                                                                                                                                               |
| D2  | `malformed_tool_call`/`prose_question` **count toward a suite's pass rate like any other failure** — no exclusion in `computeRunSummary`.                                                                                                                                           | They're still failures: the task didn't get done. Excluding them would let a suite report artificially high pass rates while silently masking a broken provider. Reports break the counts out separately so readers know _why_, without changing the math.                                                                                                                                                                                                                                                                                                     |
| D3  | `provider-compatibility` runs its scenarios **once**, same as every other suite — no new repeat-and-aggregate machinery.                                                                                                                                                            | Keeps the suite consistent with the rest of the harness (same runner, same reporting). A single hit is already an actionable signal; the issue's own evidence of intermittency (3/5 rounds) is covered by running the suite multiple times via existing 5-round tooling, not new per-suite repeat logic.                                                                                                                                                                                                                                                       |
| D4  | `provider-compatibility` **is included in the full `npm run eval` sweep** (no `--suite`) — no exclusion tag or mechanism.                                                                                                                                                           | It's just another suite file, cheap to run, and a regression (e.g. a Lemonade server upgrade changing the chat template) gets caught by the routine sweep instead of only surfacing when someone remembers to run it standalone.                                                                                                                                                                                                                                                                                                                               |
| D5  | Detection results are **additive optional fields** on the existing `ToolCallDetails`/`ToolSequenceDetails`/`LlmJudgeDetails` shapes (`malformedToolCall?`, `proseQuestion?`), not a new `details.type` discriminant, and not an ad-hoc field invented separately per executor file. | A new discriminant (mirroring `SkippedDetails`) would force duplicating `expectedTool`/`score`/`reasoning`/etc. into a parallel type per scenario kind — `SkippedDetails` only gets away with that because a skipped scenario has no other data. An ad-hoc per-executor field is exactly the "bag field repeated three times" anti-pattern `AGENTS.md`'s Composition-over-Customization section warns against. One shared shape, attached where it's relevant, read by one shared helper — matches the AC's own wording for `llm-judge` ("record **a flag**"). |
| D6  | Detection runs **once, centrally, in `runner.ts`'s `executeScenario`** — not inside `tool-call.ts`/`tool-sequence.ts`/`llm-judge.ts`.                                                                                                                                               | Those executors are deliberately pure, given only `toolCalls: InvokedToolCall[]` — they never see raw `content`. `executeScenario` already has `content`, the full tool catalog, and is where `passed`/`score` get finalized, so it's the one place that can run the detector once and apply it across all three scenario types without changing the executors' signatures.                                                                                                                                                                                    |
| D7  | The `<TOOL_NAME>` shape matches against the **harness's full tool catalog** (`config.tools`), not the per-scenario bound subset.                                                                                                                                                    | `llm-judge` scenarios bind no tools at all, yet the issue's own repro (`ws-002`/`ws-003`) requires this shape to fire there. Matching only the bound subset would make it unreachable for exactly the scenario type the comment calls out.                                                                                                                                                                                                                                                                                                                     |
| D8  | `eval:compare` (`comparator.ts`) is **not** changed in this PR.                                                                                                                                                                                                                     | Diffing a category _shift_ between two runs (e.g. "was wrong-tool, now malformed_tool_call") is a reasonable follow-up, but isn't required by the issue's acceptance criteria. Scoping it in here risks scope creep on an already two-part issue.                                                                                                                                                                                                                                                                                                              |

---

## Non-goals

- Any runtime/production change (a fallback parser in
  `api/src/services/provider-factory.ts`, or warning the user in-chat).
  Explicitly out of scope per the issue's Developer Notes — a follow-up can
  reuse the detector on the live chat path.
- Teaching `eval:compare` about failure categories (D8).
- Repeat-and-aggregate suite execution (D3).
- Any UI change — this is entirely `lib/evaluations`/`bin/eval` internal.

---

## Design

### 1. Detector module — `lib/evaluations/src/malformed-tool-call.ts`

Two small, pure, synchronous functions. No LangChain imports — inputs are
plain strings/arrays so they're trivial to unit test in isolation.

```ts
export interface MalformedToolCallMatch {
  parsedToolName: string | null;
  raw: string;
}

// Call only when the response had zero structured tool_calls. Checks, in
// order, against known shapes:
//   <tool_call>...</tool_call>  (optionally wrapping <function=NAME>)
//   <function=NAME>...
//   <|tool_call|>...
//   a JSON object anywhere in the text with name + (arguments|parameters)
//   <TOOL_NAME>...</TOOL_NAME>  — TOOL_NAME must be in knownToolNames
// Returns null when nothing matches (ordinary prose, unrelated XML/JSON).
export function detectMalformedToolCall(
  content: string,
  knownToolNames: string[],
): MalformedToolCallMatch | null;

// Call only when the scenario's expected tool is ask_user (or !ask_user)
// and zero tool calls were made. True when content ends (after trimming
// trailing whitespace/markdown punctuation) in '?'.
export function detectProseQuestion(content: string): boolean;
```

The `<TOOL_NAME>` shape is the one case that needs a name list — matching it
unconditionally would flag ordinary tag-shaped prose. Every other shape is
unambiguous on its own (the literal `<tool_call>`, `<function=`, `<|tool_call|>`
tokens, or JSON with a `name` + args/parameters key, don't show up in normal
prose by accident).

### 2. Schema changes — `lib/evaluations/src/schemas.ts`

All additive and `.optional()`, so existing on-disk result YAML keeps
parsing without a migration:

```ts
const MalformedToolCallInfoSchema = z.object({
  parsedToolName: z.string().nullable(),
  raw: z.string(),
});

// added to ToolCallDetails and ToolSequenceDetails:
malformedToolCall: MalformedToolCallInfoSchema.optional(),
proseQuestion: z.object({ raw: z.string() }).optional(),

// added to LlmJudgeDetails only — no proseQuestion there, since llm-judge
// scenarios have no expected tool to compare a question against:
malformedToolCall: MalformedToolCallInfoSchema.optional(),
```

### 3. Data flow — `lib/evaluations/src/runner.ts`

In `executeScenario`'s `tool-call`, `tool-sequence`, and `llm-judge`
branches, immediately after `content`/`toolCalls` come back from the model:

```ts
const malformedToolCall =
  toolCalls.length === 0
    ? detectMalformedToolCall(content, (config.tools ?? []).map(toolName))
    : null;
```

(`RunConfig.tools` is optional — a suite config that omits it entirely just
yields an empty catalog, so the `<TOOL_NAME>` shape never matches there,
which is the correct behavior: nothing to match against.)

merged into the branch's `details` object when non-null. For `tool-call`/
`tool-sequence` specifically, when `s.tool === 'ask_user' || s.tool === '!ask_user'`
and `toolCalls.length === 0`, also run `detectProseQuestion(content)` and
merge `proseQuestion` in when true.

**Scoring impact.** In the existing negated-tool branches
(`s.tool.startsWith('!')` in both `runToolCall` and `runToolSequence`),
`toolCalled === null` today scores a pass (1) — the forbidden tool wasn't
called. When `malformedToolCall.parsedToolName === forbidden`, `executeScenario`
must override that to `passed: false, score: 0`: the model still produced the
forbidden call, just as text, which is exactly the "negated scenario reported
as malformed_tool_call, not a pass" requirement from the issue. Everywhere
else (positive `tool-call`/`tool-sequence` scenarios, `llm-judge`), the
scenario is already scoring as a failure — detection only annotates _why_, it
doesn't flip `passed`/`score`.

### 4. Cross-type reporting helper — `lib/evaluations/src/failure-category.ts`

```ts
export type FailureCategory = 'malformed_tool_call' | 'prose_question';

export function getFailureCategory(details: ScenarioResultDetails): FailureCategory | null {
  if ('malformedToolCall' in details && details.malformedToolCall) return 'malformed_tool_call';
  if ('proseQuestion' in details && details.proseQuestion) return 'prose_question';
  return null;
}
```

One function, three consumers — no per-surface type-switch duplicated three
times.

### 5. `suites/provider-compatibility.yaml`

New suite, same shape as `tool-calling.yaml`/`explicit-tool-syntax.yaml`,
`passingThreshold: 1.0` (a transport check — any failure here is informative
regardless of threshold, not something to average away). Scenarios are
deliberately trivial, so a failure can only mean "transport/parsing problem,"
not "model reasoning problem":

- `pc-001` — single tool, no args
- `pc-002` — single tool, one string arg
- `pc-003` — nested/object args
- `pc-004` — two-step follow-up (`tool-sequence`)
- `pc-005` — unambiguous forced-clarification prompt bound to `ask_user`
  (checks for `prose_question`)

The suite's `purpose` field, and the eval docs, state explicitly: run this
first against any new model/provider; a `malformed_tool_call` or
`prose_question` result here is a configuration problem worth fixing at the
provider/server level, not something to chase by tuning a prompt.

### 6. Reporting surfaces

**CLI per-suite summary** (`bin/eval.ts`, the existing pass-rate block) —
one extra line, only rendered when nonzero, computed by filtering `results`
through `getFailureCategory`:

```
  Pass rate: 80.0%  (4/5 scenarios)
  ⚠ malformed_tool_call: 2, prose_question: 1
```

**Multi-suite sweep summary table** (the `npm run eval` no-`--suite` table)
— same counts appended in parens next to a suite's existing pass-rate,
omitted when zero.

**HTML report** — a small badge next to a scenario's result row when
`getFailureCategory` is non-null, plus the parsed tool name / raw matched
text in the same expandable detail view that already shows `matchedArgs`/
`invalidToolCalls`.

---

## Error handling & testing

**Error handling**

- The detector functions are pure and total — they return `null`/`false`
  on no match, never throw. A detector bug surfaces as a missed/false
  detection, not a scenario-execution crash.
- Everything downstream of `executeScenario` (schema parsing, CLI/HTML
  rendering, `eval:compare`) treats the new fields as optional — a result
  predating this change parses and renders exactly as it does today, just
  without category info.

**Testing**

- **Unit** (`malformed-tool-call.test.ts`) — the bulk of coverage per the
  issue's AC:
  - Each of the five `detectMalformedToolCall` shapes individually,
    including the `<TOOL_NAME>` and `<|tool_call|>` shapes from the
    follow-up comment
  - Prose that merely mentions XML/JSON without matching a shape → `null`
  - `<TOOL_NAME>` only matches when `TOOL_NAME` is in `knownToolNames`;
    an unrelated tag name → `null`
  - `detectProseQuestion`: question-ending text → `true`; declarative text,
    other trailing punctuation, empty string → `false`
- **Orchestration** (`runner.test.ts`, extending existing branch coverage):
  - `tool-call` scenario, zero structured tool calls, matching text →
    `malformedToolCall` populated, `passed: false`
  - Negated scenario where the forbidden tool appears as text → `passed:
false` (the scoring-impact override from Section 3)
  - `ask_user`-expected scenario, zero tool calls, prose ending in `?` →
    `proseQuestion` populated
  - `llm-judge` scenario with embedded tool-call text → `malformedToolCall`
    flag present alongside the normal judge score/reasoning
- **No E2E tests** — entirely `bin/eval`/harness-internal; nothing here
  touches the UI, so the repo's "every UI-behaviour PR needs E2E" rule
  doesn't apply.
- **Manual verification (handoff, not something this PR can self-certify)**
  — per the issue's AC, actually running `provider-compatibility` against
  Lemonade/Ornith and confirming it reproduces `malformed_tool_call` requires
  live local model access this environment doesn't have. Per this repo's EDD
  rules, this is a handoff: the suite ships with this PR, and the user runs
  `npm run eval -- --suite provider-compatibility --model <provider> --judge-model <provider>`
  against Lemonade/Ornith to confirm.

---

## Open design needs from the issue — resolved

The issue left two questions explicitly open; both were discussed and
resolved during brainstorming (see D2/D3 above):

1. **Pass-rate impact** — counts as an ordinary failure (D2), not excluded.
2. **Repeat runs** — `provider-compatibility` runs once like every other
   suite (D3); intermittency is handled by existing multi-round tooling, not
   new per-suite repeat logic.
