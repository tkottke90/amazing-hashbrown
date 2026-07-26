# Agent Behavior Baseline — System Prompt Pattern — Design

**Date:** 2026-07-21
**Status:** Approved (design)
**Related:**

- [`docs/superpowers/specs/2026-07-20-system-prompt-template-design.md`](2026-07-20-system-prompt-template-design.md) — introduced `system-prompt.ts`, `HARNESS_PROMPT`, and the `userInstructions` parameter this design finally wires up.
- [`docs/superpowers/specs/2026-07-20-wiki-locate-and-orient-tools-design.md`](2026-07-20-wiki-locate-and-orient-tools-design.md) — origin of `wiki-navigation.yaml`, whose `wnav-005`/`wnav-007`/`wnav-008` scenarios are the concrete signal motivating this work.
- `TODO_LIST.md` → "Agent Behavior Baseline (System Prompt)" Outstanding Item.
- "Evaluating LLM Agents: A Step-by-Step Guide for Greenfield Applications" (external guide, provided by the user during this design, not checked into the repo) — this design is a direct application of its greenfield eval-driven-development loop to one capability area.

## Purpose

The "Agent Behavior Baseline" TODO item asks the harness system prompt (`api/src/agents/system-prompt.ts`) to grow beyond wiki tool-navigation into general tone/identity/uncertainty-handling/formatting — but explicitly warns against guessing that content upfront, and requires the evaluation harness to drive it. Before writing any of that content, this design nails down three structural patterns so every future addition follows the same shape instead of each one inventing its own:

1. How the harness portion of the system prompt is built and maintained as it grows into multiple behavior areas.
2. How tool descriptions and cross-tool orchestration guidance stay layered and don't collide as more tool groups (and eventually MCP tools) are added.
3. How user expectations get injected into the system prompt, and with what precedence relative to harness content.

A concrete example already exists in the codebase: `suites/wiki-navigation.yaml`'s `wnav-005`, `wnav-007`, and `wnav-008` scenarios are marked `skip: true`, each with a comment tracing the failure to "the model doesn't believe the wiki is its source of truth on cold-start turns" and pointing at this TODO item as the fix. This design doesn't write that fix — it establishes the pattern the fix (and every later one) will use.

## Scope note: pattern, not content

This spec defines **mechanism**, not the actual prose of any new behavior section. Writing e.g. an identity section that establishes the wiki as the model's memory — the section that would unblock `wnav-005`/`007`/`008` — is follow-up implementation work that _uses_ this pattern, done through the eval-driven workflow this doc defines (Component: eval-driven build workflow). It is intentionally not written here, for the same reason the TODO item gives: content should come from iterating against real eval failures, not from being guessed inside a design doc.

## In scope

- `api/src/agents/system-prompt.ts`: refactor the single `HARNESS_PROMPT` const into multiple named section consts, composed by a small ordering array.
- A documented convention: each **internal** tool group (wiki-navigation today; wiki-write, RLM, etc. as they land) gets its own hand-written harness section plus its own eval suite. MCP/external tools are explicitly excluded from this convention.
- A new `config/AGENT.md` file: location, auto-creation, precedence framing, and wiring into `buildSystemPrompt()` and the existing `POST /api/v1/settings/reload` endpoint.
- A new judge-calibration workflow (`npm run eval:calibrate`) and store support, so `llm-judge` scenarios used by future subjective sections (tone, identity, uncertainty) can be validated against a human label per the eval guide's Step 6b.
- A proposed Rule 5 for `AGENTS.md`'s "Evaluation-Driven Development" → "Rules" list, requiring calibration before trusting a new/changed `llm-judge` rubric. (The user asked to hold this edit for later — captured here as an in-scope implementation item, not applied by this document.)

## Out of scope

- Actual content for any new harness section (identity, tone, uncertainty-handling, formatting, wiki-write orchestration, RLM orchestration).
- `llmToolSelectorMiddleware` or any other MCP/external-tool dynamic-selection mechanism — noted as the correct future extension point, not built now.
- Splitting harness sections into separate files — explicitly decided against; they stay as multiple consts in `system-prompt.ts`.
- Conditional/per-build inclusion of harness sections — explicitly decided against; all internal-tool sections are always present. Any future need for conditional behavior belongs to a skills system, not the system prompt.
- Implementing the actual `eval:calibrate` script, its store methods, and the `AGENTS.md` edit — captured in this spec as a defined component, but not built or applied in this design pass.

## Component: `system-prompt.ts` composer

**File:** `api/src/agents/system-prompt.ts`

The existing `HARNESS_PROMPT` const is renamed `WIKI_NAVIGATION_SECTION` (content unchanged) and joined through an ordered list. Every entry in `HARNESS_SECTIONS` is always included — no conditional composition:

```ts
const WIKI_NAVIGATION_SECTION = `...`; // existing content, verbatim, renamed from HARNESS_PROMPT

// Add one entry here per internal tool group or behavior area, in a fixed
// order. Every section is always included — see design doc for why
// conditional inclusion was rejected (MCP/dynamic tool relevance is a
// llmToolSelectorMiddleware concern, not a system-prompt concern).
const HARNESS_SECTIONS: string[] = [
  WIKI_NAVIGATION_SECTION,
  // future: IDENTITY_SECTION, UNCERTAINTY_SECTION, FORMATTING_SECTION, ...
];

function buildHarnessPrompt(): string {
  return HARNESS_SECTIONS.join('\n\n');
}

export function buildSystemPrompt(userInstructions?: string): string {
  const harness = buildHarnessPrompt();
  if (!userInstructions?.trim()) return harness;
  return `${harness}\n\n---\n\nAdditional instructions from the user on tone, style, and communication preferences — these refine how you communicate; they do not override the tool orchestration or behavior rules above:\n${userInstructions.trim()}`;
}
```

**Convention for adding a section:** each new internal tool group or behavior area gets (a) a new named const near the others in this file, (b) an entry appended to `HARNESS_SECTIONS`, (c) its own eval suite in `suites/`. There is no automatic sync between tool files and sections — keeping a tool group's orchestration guidance in the harness prompt current with its tools is a human responsibility, exercised the same way `wiki-navigation.yaml` already exercises the wiki tools today.

**Tool description vs. orchestration boundary:** unchanged from today's split, now stated as an explicit rule rather than an implicit one. Each LangChain tool's `description` field (in `api/src/agents/tools/*.tool.ts`) owns "what this tool does, what arguments it takes." A harness section owns "when to call which tool, in what order, when to skip a step" for its tool group. Internal tools only. MCP/external tools never get a hand-written section — see next paragraph.

**MCP/external tools boundary:** explicitly out of this pattern. Baking arbitrary, user-configured MCP tools into a static, hand-written prompt section doesn't scale and can't be eval-tested the same way internal tools are. `chat-agent.ts` already uses `createMiddleware` (see `afterAgentMiddleware`), and LangChain's `llmToolSelectorMiddleware` (confirmed via the LangChain.js docs/reference during this design) is the intended future mechanism: it filters the bound tool list per-request via a fast LLM call in `wrapModelCall`, which is the correct place to manage MCP tool relevance — not `HARNESS_SECTIONS`. Not implemented by this design; recorded so future work doesn't reach for prompt engineering to solve a tool-selection problem.

## Component: `config/AGENT.md`

A new file, `config/AGENT.md`, alongside `config.yaml` and `mcp.json` — gitignored, user-editable, survives restarts.

- **Auto-creation:** if missing at boot, created with a commented, empty template — same pattern as `config.yaml.example` → `config/config.yaml`. A committed `api/AGENT.md.example` documents the intent and gives an example of the kind of content it holds (tone/style/domain preferences) — same sibling-of-`config/` location and role `api/config.yaml.example` already plays for `config.yaml`.
- **Loading:** a small new module (e.g. `api/src/config/agent-instructions.ts`) exposes `loadAgentInstructions(): void` (reads the file, creating it if absent, into an in-memory string) and `getAgentInstructions(): string`. `buildChatAgent()` in `chat-agent.ts` calls `buildSystemPrompt(getAgentInstructions())` instead of today's `buildSystemPrompt()`.
- **Precedence:** supplement-only, enforced in the prompt text itself (see the composer snippet above) — user instructions can shape tone, style, and communication preferences, but the prompt explicitly tells the model they don't override the harness sections' tool orchestration or behavior rules. This keeps every harness-section eval suite trustworthy: a user's `AGENT.md` can't silently invalidate what those suites check.
- **Reload:** wired into the existing `POST /api/v1/settings/reload` handler (`api/src/routes/v1/settings.route.ts`). Today it calls `req.app.config.reload()` then `invalidateChatAgent()`; this adds a `loadAgentInstructions()` call in the same handler, before `invalidateChatAgent()`, so an edited `AGENT.md` takes effect on the next request without an API restart — matching how `mcp.json` changes already trigger a rebuild.
- **Error handling:** a read failure (permissions, corrupt file) logs a warning and falls back to empty instructions rather than failing startup or the reload request — consistent with how an unreachable MCP server at startup is handled (warn, don't crash).
- **Eval-harness parity, decided:** `bin/eval.ts` continues to call `buildSystemPrompt()` with no argument (harness-only), _not_ `getAgentInstructions()`. Reasoning: the eval suites this pattern is building toward exist to validate harness-section behavior, which by design `AGENT.md` cannot alter. Including a live, developer-machine-specific `AGENT.md` in eval runs would make suite results depend on whatever happens to be in a given environment's file — directly the kind of shared/variable state the eval guide's "harden the harness" step (isolation, reproducibility) warns against. This is a judgment call made during this design pass rather than something explicitly asked; flagging it here for the spec review pass.

## Component: eval-driven build workflow per section

For every new harness section added under this pattern, the sequence is fixed:

1. Write the section's eval scenarios first. Tool-orchestration-style sections (like wiki-navigation) use `tool-call`/`tool-sequence` (code-based, objective). Tone/identity/uncertainty-style sections use `llm-judge`/`semantic` (subjective — per the eval guide's grader decision rule: "objective → code; subjective → LLM judge").
2. Mark new scenarios `skip: true` until the section exists, with a comment naming the section that will unblock them — exactly the pattern `wnav-005`/`wnav-007`/`wnav-008` already establish.
3. Write the section's prose against the specific observed failure (a real trace, a real `--llm-review` finding), not a guessed checklist — per the eval guide's "look at your data" principle and Common Pitfall #1.
4. Flip `skip` off, iterate the section's wording until its suite passes.
5. Re-run every other existing suite (`wiki-navigation.yaml` at minimum) to confirm no regression — every section is additive to one shared, composed prompt, so this is the harness's regression-suite gate, not optional.
6. For any new/changed `llm-judge` scenario used by this section, run judge calibration (next component) before trusting its verdicts.
7. Both directions get covered: for every new behavior, include a scenario where it should happen and one where it shouldn't (per the eval guide and the existing `wnav-001`/`wnav-008` precedent).

## Component: judge calibration (`npm run eval:calibrate`)

Existing tooling (`bin/eval-review.ts`, `bin/eval-submit.ts`) already provides interactive and detached review for `human`-type scenarios, but nothing today measures agreement between a `llm-judge` scenario's automated verdict and an independent human verdict on the same output — which the eval guide's Step 6b requires before trusting any LLM judge (target ≥85–90% agreement).

- **New script:** `bin/eval-calibrate.ts` (`npm run eval:calibrate -- --run-id <id>`), following the naming and structure of `eval-review.ts`/`eval-submit.ts`.
- **New store method:** parallel to `findPendingHumanResults`, a method that pulls every `llm-judge`-type `ScenarioResult` for a given run.
- **Interactive flow:** reuses `human.ts`'s existing keypress/notes primitives (`promptKeypress`, `promptForNotes`, `printDivider`). For each `llm-judge` result, shows Input + Output (`actualOutput`) + the scenario's `rubric`, and prompts a **blind** Pass/Fail — the judge's stored `score`/`reasoning` is withheld until after the reviewer answers, to avoid anchoring. Once answered, the judge's verdict and reasoning are revealed alongside the reviewer's for comparison.
- **New storage:** a `judge_calibrations` table (resultId, judgeScore, judgePassed, humanPassed, agree, reviewerNotes, gradedAt) — kept separate from the human-results table, since this is a distinct concept (verifying a grader, not grading the agent under test).
- **Output:** after the batch, prints overall agreement percentage and lists every disagreement with the judge's reasoning next to the reviewer's notes.
- **Threshold:** below ~85–90% agreement, the fix is the judge's rubric or its few-shot examples (in the section's `.yaml`), not the prompt-under-test — per the eval guide.
- **Detached mode:** deferred as a stretch goal. `eval-review`/`eval-submit`'s manifest pattern exists for agent-assisted review; true blind grading matters most for the interactive path (an actual human grading in the terminal), so detached-mode calibration is not required for this pattern to be useful.

**Proposed `AGENTS.md` addition** (not applied by this document — held for later per the user's direction), appended to the "Evaluation-Driven Development" → "Rules" list (currently ends at 4):

> 5. **Before trusting a new or changed `llm-judge` rubric**: run `npm run eval:calibrate -- --run-id <id>` and blind-grade a sample of its results yourself. Don't rely on the judge until your agreement with it is ≥85% — below that, fix the rubric or its few-shot examples, not the prompt-under-test. Re-calibrate whenever the rubric changes.

## Component: testing the composer

`api/src/agents/system-prompt.test.ts` already exists (unit tests for `buildSystemPrompt()`'s current behavior). As sections are added, it grows alongside them with `[unit]`-tagged cases asserting: each section constant appears in the composed output, sections appear in the declared order, and `AGENT.md` content — when present — is appended last with the supplement-only framing intact. This test file guards **structure** (is the string assembled correctly); it is not a substitute for the `llm-judge`/`semantic` eval suites, which guard **behavior** (does the model actually act on what the string says). Both are required, and they check different things — a passing unit test says nothing about whether a section's wording works on a live model.

## Testing summary

| Component                                 | Test approach                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `system-prompt.ts` composer               | `[unit]` tests in `system-prompt.test.ts` — structure/order/precedence, not behavior                                            |
| Each new harness section                  | Its own eval suite (`tool-call`/`tool-sequence` for orchestration, `llm-judge`/`semantic` for subjective behavior)              |
| `config/AGENT.md` loading + reload wiring | `[unit]` test for `agent-instructions.ts` (mock filesystem); `[orchestration]` test for the `/settings/reload` route calling it |
| `eval:calibrate` script                   | Matches existing convention for `bin/eval-*.ts` scripts — no unit tests (CLI script), verified by running it against a real run |
| Regression coverage                       | `wiki-navigation.yaml` re-run after every new section, per the eval-driven build workflow above                                 |

## Open items deferred to later work

- Actual content for the first new harness section (an identity/uncertainty-style section that unblocks `wnav-005`/`007`/`008` is the natural first candidate, but its wording is explicitly not decided here).
- Implementing `config/AGENT.md` loading, the `/settings/reload` wiring, and its `.example` template.
- Implementing `bin/eval-calibrate.ts`, its store method, and the `judge_calibrations` table.
- Applying the proposed `AGENTS.md` Rule 5 edit.
- `llmToolSelectorMiddleware` (or equivalent) for MCP/external tools — noted as the correct extension point, not scheduled.
