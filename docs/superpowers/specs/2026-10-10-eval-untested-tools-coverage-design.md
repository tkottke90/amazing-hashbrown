# Eval Coverage for Untested Tools — Design

**Issue:** [#276 — Chore: Cover untested tools in eval suites](https://github.com/tkottke90/amazing-hashbrown/issues/276)
**Epic:** #270 — Eval system reliability hardening
**Date:** 2026-10-10

## Context

A cross-reference of `api/src/agents/tool-catalog.ts`, `chat-agent.ts`'s
`STATIC_CHAT_TOOLS`/`WAKEUP_TOOLS`, and the standalone prompt-producing
modules under `api/src/agents/` against `suites/*.yaml` found several
shipped production capabilities with zero eval coverage:

- `cancel_wakeup`
- `search_conversation`
- `spawn_sub_agent` (including its nesting-restriction guarantee)
- `wiki_create_domain`
- the wiki-ingestion agent's own system prompt
- `loop-reflection.ts`'s real `evaluateLoopProgress` function (only
  exercised today through `loop-guard.yaml`'s hand-written stand-in)

Two further gaps — `lib/rlm`'s internal reasoning loop, and live
multimodal image analysis on an initial turn — are architecturally
harder to close and need an explicit documented decision rather than
being left looking like oversights.

This is purely additive eval-authoring work: no production behavior
changes, only new/extended suite YAML, one small tool-registration fix
in the eval harness setup, and a documentation addition.

## Architectural findings that shape this design

Two facts about the eval harness, confirmed by reading `bin/eval-setup.ts`
and `lib/evaluations/src/{runner,schemas}.ts`, determine what's actually
buildable here:

1. **The harness has one global, flat tool list.** `bin/eval-setup.ts`'s
   `evalTools` array is shared by every suite — the harness has no
   concept of "which agent" a suite models, only a system-prompt swap
   (`appliesHarnessSystemPrompt`) plus this one tool superset.
   `search_conversation`, `spawn_sub_agent`, and `wiki_create_domain`
   are not in that list today, so three of the five "missing coverage"
   items require a small code change to `eval-setup.ts`, not just YAML.
   `cancel_wakeup` is already bound there — that one is pure YAML.

2. **The scenario schema has no image/attachment field.** Checked
   directly in `lib/evaluations/src/schemas.ts` and `runner.ts` — a
   scenario's `input`/`turns` are plain strings only, with no type for
   attaching image content to any turn. The harness genuinely cannot
   simulate a multimodal turn today. This is stated as a plain fact
   below, not an opinion on whether it's permanently out of scope.

3. **`spawn_sub_agent`'s nesting restriction is a code fact, not model
   behavior.** It's enforced by `getSubAgentToolIds()` hard-excluding
   `ask_user`/`spawn_sub_agent` from a sub-agent run's tool set,
   regardless of config. The eval harness has no mechanism to give one
   suite a different (restricted) tool set than another, so there is no
   faithful way to eval-test this as LLM behavior — any scenario
   attempting it would really be testing prompt-compliance against a
   fabricated constraint, the same weakness the reliability audit
   already flagged in `loop-guard.yaml`'s lg-002 ("a representative
   stand-in"). It also turns out to already be covered correctly, at
   the right layer: `tool-config.test.ts:188` —
   `getSubAgentToolIds() never includes ask_user/spawn_sub_agent even
when forced on`. Nothing needs to be built for this item.

## Scope

| #   | Item                                                        | Change                                                                                     |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | `cancel_wakeup`                                             | Extend `suites/agent-wait.yaml`                                                            |
| 2   | `search_conversation`                                       | New suite `suites/conversation-search.yaml`                                                |
| 3   | `spawn_sub_agent` delegation decision                       | New suite `suites/sub-agent-delegation.yaml`                                               |
| 4   | `spawn_sub_agent` nesting restriction                       | No new code — already covered by `tool-config.test.ts:188`; cited in (3)'s suite `purpose` |
| 5   | `wiki_create_domain` + wiki-ingestion agent's system prompt | New suite `suites/wiki-ingestion-agent.yaml`                                               |
| 6   | `loop-reflection.ts`'s `evaluateLoopProgress`               | New suite `suites/loop-reflection.yaml`                                                    |
| 7   | Tool registration gap                                       | Code change: `bin/eval-setup.ts`                                                           |
| 8   | RLM internal loop / multimodal scope note                   | Doc addition: `docs/App-Docs/Evaluations.md`                                               |

All of it ships as one PR.

## Suite changes

### `suites/agent-wait.yaml` — add `cancel_wakeup` scenarios

Follows the file's existing `aw-00x` pattern (seeded `tool-sequence`
turns, `tool-call`/`tool-sequence` scenario types):

- **Positive**: seed a pending wake-up (`tool-sequence`: a
  `schedule_wakeup` call + result), then a user turn saying the wait is
  no longer needed → assert `tool: cancel_wakeup`,
  `argChecks: [{path: reason, match: exists}]`.
- **Negative**: same seeded pending wake-up, user asks an unrelated
  question → assert `tool: '!cancel_wakeup'`, plus a `responseRubric`
  checking the reply doesn't falsely claim to have cancelled anything
  (mirrors `aw-005`'s reasoning for why a tool-name check alone isn't
  enough).

### `suites/conversation-search.yaml` (new) — `search_conversation`

- **Positive**: seed a long thread (≥20 prior turns — matches the
  tool's own default threshold in `search-conversation.tool.ts`) where
  the user asks about something discussed many turns back → assert
  `tool: search_conversation`, `argChecks: [{path: query, match: exists}]`.
- **Negative**: short thread (<20 turns), user asks about something
  still visible in context → assert `tool: '!search_conversation'`
  (the tool's own "not needed yet" branch below threshold means
  reaching for it here would be the wrong call).

### `suites/sub-agent-delegation.yaml` (new) — `spawn_sub_agent` delegation decision

- **Positive**: a clearly bounded, delegable sub-task → assert
  `tool: spawn_sub_agent`,
  `argChecks: [{path: role, match: exists}, {path: goal, match: exists}]`.
- **Negative**: a simple in-context question that doesn't warrant
  delegation → assert `tool: '!spawn_sub_agent'`.
- Suite `purpose` field states explicitly that the nesting restriction
  is intentionally not covered here, citing `tool-config.test.ts:188`
  as the real guarantee.

### `suites/wiki-ingestion-agent.yaml` (new) — `wiki_create_domain` + the agent's own system prompt

`appliesHarnessSystemPrompt: false`, following the `after-agent.yaml`/
`thread-titles.yaml` convention: the suite's system prompt is the
literal text `buildWikiIngestionSystemPrompt()` produces, since in
production this agent never runs under the chat-agent harness prompt.

- **wiki_create_domain tool-call**: user describes a brand-new topic
  with no existing domain → assert `tool: wiki_create_domain`,
  `argChecks` on `wikiId`/`domain`.
- **Orient-first** (`tool-sequence`): tests the prompt's "orient before
  writing" rule — seed a user ask to document something, assert the
  first tool call is `wiki_orient`/`wiki_locate`, not a write tool.
- **Domain-exists discrimination**: user references a domain that
  (per seeded context) already exists on disk → assert
  `tool: wiki_register_domain`, not `wiki_create_domain` — the exact
  distinction the tool's own description draws
  (`wiki-create-domain.tool.ts`).

### `suites/loop-reflection.yaml` (new) — `evaluateLoopProgress`

`appliesHarnessSystemPrompt: false`, `type: structured` with
`outputSchema` mirroring `ReflectionResultSchema`
(`{converging, summary, guidance?}`). `input` is built the same way
`buildReflectionPrompt()` renders it in production: the reason framing
plus a numbered rendering of seeded `toolCallPairs`.

- **Stagnation**: seed 3+ identical `shell_exec` call/result pairs,
  `reason: 'stagnation'` framing →
  `fieldChecks: [{path: converging, match: equals, value: false}]`.
- **Genuine progress**: seed a varied, clearly-productive tool-call
  sequence, `reason: 'streak'` framing →
  `fieldChecks: [{path: converging, match: equals, value: true}]`.

This is complementary to, not a replacement for, `loop-guard.yaml` —
that suite tests the chat agent's reaction to injected guidance; this
suite tests whether the guidance-generating function itself judges
convergence correctly against a real model.

## Code changes

### `bin/eval-setup.ts`

Add three entries to `evalTools`, each with a comment following the
file's existing convention (production bind site, why unconditional
inclusion is safe for an eval run that never executes tools):

```ts
import { searchConversationTool } from '../api/src/agents/tools/search-conversation.tool.js';
import { spawnSubAgentTool } from '../api/src/agents/tools/spawn-sub-agent.tool.js';
import { wikiCreateDomainTool } from '../api/src/agents/tools/wiki-create-domain.tool.js';
```

added into the `evalTools` array alongside `scheduleWakeupTool`/
`cancelWakeupTool`.

### No unit test addition needed

`tool-config.test.ts:188` already asserts
`getSubAgentToolIds() never includes ask_user/spawn_sub_agent even when forced on`.
This design cites it rather than duplicating it.

## Documentation addition

New section in `docs/App-Docs/Evaluations.md`, sibling to the existing
`appliesHarnessSystemPrompt` section:

- **RLM's internal reasoning loop**: out of scope for this harness, by
  architectural decision. Per ADR-001 (`docs/ADR.md`), any corpus
  seeded into a scenario's prior turns is visible context to the
  top-level model, so RLM delegation itself can't be forced or
  observed at the eval level — confirmed when `rlm-002`/`rlm-005` were
  restructured away from a required-delegation assertion. The ceiling
  is structural, not a calibration gap, and isn't expected to change.
- **Live multimodal image analysis**: stated as a plain current
  limitation, not a scope decision — the scenario schema
  (`lib/evaluations/src/schemas.ts`) has no field for attaching image
  content to any turn, confirmed by reading the schema and runner
  directly. No suite can simulate a multimodal turn today. (Whether
  this gets fixed is tracked separately — this note only documents why
  it's absent today, deliberately avoiding a permanence claim the
  codebase doesn't support.)

## Validation & handoff

- `npm run lint` and `npx prettier --check .` run locally after writing
  the YAML and the `eval-setup.ts` change.
- Per this repo's EDD rule 5, this session has no network path to the
  local model providers (Ollama/Lemonade/etc.) these suites run
  against, so the actual `npm run eval` passes can't be executed or
  confirmed from here. Each new/extended suite's exact runnable command
  will be handed off explicitly once the YAML is written, per the rule.
  Nothing here is "done" until those runs are seen to pass.
- Issue #276's own measurable success criterion —
  `grep -l '<tool or function name>' suites/*.yaml` returning at least
  one match for each of `cancel_wakeup`, `search_conversation`,
  `spawn_sub_agent`, `wiki_create_domain` — is checked mechanically
  after the YAML lands.
