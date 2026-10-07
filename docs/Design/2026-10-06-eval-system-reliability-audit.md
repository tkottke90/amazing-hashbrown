# Eval System Reliability Audit

**Date:** 2026-10-06
**Status:** Findings accepted, remediation not yet started
**Scope:** The eval harness (`lib/evaluations`, `bin/eval*`), the suites under
`suites/*.yaml`, the baseline mechanism (`eval-baselines.yaml`), the three
automation skills built on top of the harness (`auto-eval-loop`,
`auto-eval-pr-comment`, `auto-update-baseline`), and the model/hardware
landscape the harness is evaluated against.

## Context

The evals have been reported as flakey and unreliable, especially when
scored by the LLM-as-judge path, to the point that current results aren't
trusted. This audit was commissioned to answer four questions before any
remediation work starts:

1. Is the hardware/model landscape used for eval runs good coverage?
2. Does the eval harness itself (not the eval content) have gaps that would
   produce unreliable results?
3. Do the automation skills built around the harness have gaps in how they
   execute or interpret eval runs?
4. Are the eval suites themselves (`suites/*.yaml`) good quality, and where
   is coverage missing?

This is a findings document, not an implementation plan. Nothing in the
harness, suites, or skills has been changed as part of this audit. A
prioritized remediation roadmap is proposed at the end.

## Executive summary

The "flakey, especially under an unbiased judge" complaint is real, and it
is mostly explained by two confirmed root causes rather than being a vague,
unfixable property of LLM evals in general:

1. **No temperature or seed control exists anywhere in the provider
   construction path** (`api/src/services/provider-factory.ts`), for the
   model under test *or* the judge. The codebase's own commit history
   already attributes measured **4/7 (~57%) pass-rate swings on identical
   reruns** to this.
2. **`--judge-model` silently falls back to the same model as `--model`**
   when omitted (`bin/eval.ts:160`), contradicting the harness's own
   original design intent, with no hard stop — only a `biasRisk` boolean
   buried in the result JSON.

Everything else found in this audit — 5-round baseline averaging, the
auto-eval-loop acting on single runs, per-model capability-ceiling triage
recorded in `system-prompt.ts` — is the team *compensating* for these two
root causes rather than fixing them at the source. Fixing them first is
expected to make most of the remaining work (re-baselining, suite cleanup)
far more productive, because right now it's difficult to tell "real
regression," "known model ceiling," and "sampling noise" apart from a
single run.

The suite content itself is better than average for an LLM eval corpus —
most scenarios carry a real, specific `purpose`, and several suites show
genuine iterative tuning backed by actual failure transcripts with
confirmed per-model ceilings called out rather than chased further. The
gaps that exist are concrete and fixable, not evidence the whole suite
needs to be rebuilt.

---

## 1. Hardware & model landscape

Current setup:

| Backend | Hardware | Model(s) |
|---|---|---|
| Ollama | Apple M1 Mac (local, low power) | `gpt-oss:20b` |
| Lemonade ("lemonade") | AMD Ryzen AI Max+ 395 (dedicated local box) | GLM-4.7-Flash |
| Lemonade ("ornith", 2nd registration on same box) | same box | Ornith-1.5 |
| DigitalOcean serverless inference | cloud | GLM-5.3-Flash |
| Anthropic API | cloud | Claude Sonnet 5 (judge only) |

### Hardware coverage: good

Three genuinely distinct deployment targets — a low-power laptop, a
purpose-built local accelerator box, and cloud serverless inference. This
is the right axis to vary and does not need changing.

### Model coverage: narrower than it looks

Two caveats worth being explicit about:

- **Lemonade and DigitalOcean are code-identical integration paths.**
  Both are OpenAI-compatible endpoints, and both are constructed through
  the exact same `ChatOpenAI` branch of `createProviderFromConfig()`
  (`api/src/services/provider-factory.ts:59-73`), differing only in
  `baseUrl`/`apiKey`/`defaultModel`. Four configured provider entries are
  really two distinct code paths (`ollama` vs. `openai`-compatible), not
  four. This is fine as *production* provider support, but it means
  "tested against 4 providers" overstates how many independent transport
  surfaces are actually being exercised.
- **Every model in rotation is a small/fast variant.** `gpt-oss:20b`,
  GLM-4.7-Flash, GLM-5.3-Flash, and Ornith-1.5 are all optimized for speed,
  not peak capability. The codebase has already found hard, reproducible
  capability ceilings on these models — Ornith collapsing a resolved
  multi-candidate tie back into "it was always one match" across at least
  9 consecutive runs (`api/src/agents/system-prompt.ts:243-260, 700-719`),
  Lemonade skipping `ask_user` entirely on a reported tie
  (`system-prompt.ts:600-659`), and a local Qwen build ignoring a stated
  fact and re-searching anyway, confirmed across three independent
  scenarios (`suites/wiki-write.yaml:320-346, 371-395`). The team's
  conclusion that these are genuine ceilings rather than prompt bugs is
  reasonable, but there is no local model in rotation that's *expected* to
  pass everything, so every new failure on a small model still has to be
  triaged by inspection rather than by comparison against a stronger
  baseline.

### Recommendation

Keep the current three-backend hardware spread. Add one mid/large local
model — e.g. Qwen3-30B-A3B or Qwen3-32B, which has strong native
tool-calling and should run acceptably on the Ryzen AI Max+ box — as an
occasional ceiling-check baseline, not a model run every round. When a
small model fails a scenario, running it once against this stronger model
answers "is this a real harness/prompt bug (the strong model fails too) or
a capability ceiling (the strong model passes)?" without guesswork. This
converts the current ad hoc ceiling triage in `system-prompt.ts` into
something that can be confirmed rather than inferred.

---

## 2. Eval harness (tooling) findings

Scope: `lib/evaluations/src/*`, `bin/eval*.ts`, `api/src/services/provider-factory.ts`,
`api/src/config/env.ts`, `eval-baselines.yaml`, `docs/App-Docs/Evaluations.md`.

### 2.1 Judge configuration and bias control — confirmed gap

- `lib/evaluations/src/executors/llm-judge.ts:35-81` builds a judge prompt
  and scores via `judgeModel.withStructuredOutput(JudgeResponseSchema).withRetry({ stopAfterAttempt: 3 })`.
- `biasRisk: judgeModelId === modelId` (`llm-judge.ts:79`) is a **string
  comparison that produces a flag only** — it does not block the run, warn
  loudly, or change scoring. The scenario still passes/fails on that
  same-model score.
- `bin/eval.ts:160`: `const judgeModelId = values['judge-model'] ?? values.model;`
  — if `--judge-model` is omitted, the judge silently defaults to the
  exact model under test. This is the opposite of the original design:
  `docs/Design/2026-07-15-evaluation-harness-design.md:409-411, 990`
  explicitly states the judge model "must be provided explicitly — using
  the same model as judge introduces a conflict of interest" and that
  `judgeModel: BaseChatModel` is "required — no same-model fallback."
  What shipped contradicts what was designed.
- `docs/App-Docs/Evaluations.md:55` documents the current fallback
  behavior accurately, but does not flag that it's a weaker guarantee than
  originally intended, or warn that omitting `--judge-model` silently
  biases every `llm-judge`/`responseRubric` result in that run.
- **No temperature, seed, top_p, or multi-sample/median voting exists
  anywhere in the judge path.** The judge is invoked once per scenario at
  whatever default sampling settings the provider SDK uses.
- `JudgeResponseSchema`'s `score` field deliberately omits `.min()/.max()`
  because Anthropic's structured-output validation rejects JSON-schema
  `minimum`/`maximum` constraints that OpenAI-compatible endpoints accept
  (`llm-judge.ts:6-12`) — a known, already-worked-around cross-provider
  structured-output inconsistency, but it means the Anthropic judge path
  gets *less* schema enforcement than an OpenAI-compatible judge would.
- A judge-calibration tool exists (`bin/eval-calibrate.ts`), but it is a
  manual, human-gated sanity check run on demand — not something the
  harness runs automatically or gates scenario results on.

**This is the single most direct connection to the "unbiased judge"
complaint**: there is no enforced guarantee the judge is ever a different
model from the one being graded, and no control over the judge's own
sampling variance.

### 2.2 Provider/model configuration

- `api/src/config/env.ts:18-40` (`ProviderSchema`): `name`, `type:
'ollama'|'openai'|'anthropic'`, `baseUrl`, `apiKey`, `defaultModel`,
  `models`, `maxConcurrency`, `timeoutMs`. **No `temperature`, `topP`,
  `seed`, or context-window field exists in this schema at all.**
- `api/src/services/provider-factory.ts:44-90` (`createProviderFromConfig`):
  ```ts
  case 'ollama':    new ChatOllama({ model, baseUrl })
  case 'openai':    new ChatOpenAI({ model, apiKey, timeout, configuration })
  case 'anthropic': new ChatAnthropic({ model, apiKey, clientOptions: { timeout } })
  ```
  None of the three constructors is passed `temperature`, `topP`, or
  `seed`. **Confirmed gap**, and the direct mechanism behind §2.3 below.
- **Timeout is wired for `openai` and `anthropic` types** (if
  `timeoutMs` is set in config — it's optional, no default) **but
  explicitly not wired for Ollama** (`provider-factory.ts:55-58`, "known
  gap, deliberately deferred" per the inline comment) — a hung/slow call
  to the M1 Ollama instance has no harness-level timeout at all.
- **No retry on transient failure for the target model.** The only retry
  anywhere in the harness is the judge's `withRetry({ stopAfterAttempt: 3 })`,
  scoped to parse failures on the judge's structured-output call. A single
  dropped/slow connection to the Lemonade box or the DigitalOcean endpoint
  fails that scenario outright (`runner.ts`'s `invokeModel` /
  `invokeToolCallModel` / `invokeStructuredModel` have no retry wrapper;
  a thrown error is caught by `executeScenario` and scored as a hard
  `0`, `runner.ts:1094-1110`).
- Scenario execution order is deterministic (file order; suite IDs sorted
  alphabetically when no `--suite` is given, `bin/eval.ts:443-444`) — not
  a flakiness source.
- The production per-provider concurrency gate
  (`api/src/services/provider-queue.ts`) is never used by the eval
  harness — moot, since `runEval` executes scenarios strictly
  sequentially (`runner.ts:1177-1182`), so there's no request pile-up to
  gate.

### 2.3 Determinism and flakiness sources — confirmed, with direct evidence from this repo's own history

The lack of temperature/seed control is not a theory; the team has
already measured its effect:

- `api/src/services/default-skills.ts:59-64`: *"cwp-001/cwp-002 also
  failed for Lemonade this round (previously passing)... most likely
  sampling variance (Lemonade's ChatOpenAI construction sets no
  temperature/seed... not a regression."*
- `api/src/services/default-skills.ts:95-98`: a similar note for a local
  Ollama run.
- `docs/superpowers/specs/2026-09-14-wiki-navigation-section-restructure-design.md:11,18`:
  *"Lemonade's (GLM-4.7-Flash-GGUF) confirmed sampling flakiness... 4/7
  pass rate across identical-condition reruns... confirmed as real
  model-sampling variance, not a fixable wording gap."*

The team's response to that finding was a prompt-structure rewrite
(numbered checklist vs. prose) — a mitigation applied *around* the
variance, not a fix at the source. `eval-baselines.yaml`'s own schema is
a second, independent admission of the same unresolved problem: it
deliberately averages **5 frozen rounds** into a baseline score rather
than trusting a single run, specifically because "these suites have
measured sampling variance... a baseline from one lucky or unlucky run
would misinform exactly the 'is this a real regression' question"
(`eval-baselines.yaml` header comment; recorded scores like `15.4`,
`17.2`, `16.8` — non-integer averages are themselves numeric evidence of
real run-to-run variance on identical commits).

`llm-judge`-type scenarios compound this: the target model's call and the
judge's call are *both* unseeded, non-zero-temperature LLM calls, and
nothing in the harness separates "the target model's output varied" from
"the judge's scoring of a fixed output varied" when a run disagrees with a
previous one.

### 2.4 Baseline mechanism — confirmed gap: not actually a regression gate

- `eval-baselines.yaml` is git-tracked (not in `.gitignore`) and holds,
  per suite and per provider/model slug: `provider`, `model`,
  `judgeModel`, `score` (average `passedScenarios` over `rounds`),
  `total`, `rounds` (5), `updatedAt`, `branch`, `commit`.
- It is written by `.agents/skills/auto-update-baseline/scripts/update-baseline.mjs`,
  which does not run evals itself — it only records a number the calling
  skill computed from N round outputs, and **overwrites** the prior entry
  (`doc.setIn(...)`, no additive history; the only trace of a prior value
  is an ephemeral console line, not persisted anywhere).
- **Nothing in the harness or CI reads this file to compare a new run
  against it.** `lib/evaluations/src/comparator.ts`'s `compareRuns`
  compares two *run* objects passed in by id — never a baseline file.
  `npm run eval` is never invoked in `.github/workflows/*` (verified by
  grep across all four workflow files), and `eval-baselines.yaml` is
  referenced in exactly three non-generated files in the whole repo: the
  design doc that introduced it, the skill that writes it, and the script
  itself.

In short: a baseline exists and is deliberately averaged to resist
sampling noise, but "is this a real regression" is still answered only by
a human (or an agent) eyeballing numbers side by side — there is no
automated gate anywhere.

### 2.5 Result storage — adequate for reasoning failures, weak for transport/timing forensics

Each scenario result (`schemas.ts:577-593`) captures `actualOutput`,
`latencyMs`, `estimatedCostUsd`, `score`, `passed`, and rich type-specific
detail — judge `reasoning`/`judgeModel`/`biasRisk`; tool-call `calledTools`/
`matchedArgs`/`invalidToolCalls`/`responseMetadata`/`reasoningContent`/
`malformedToolCall`/`proseQuestion`; full conversation transcripts for
seeded multi-turn scenarios. This is a genuinely solid basis for debugging
*reasoning* failures after the fact.

It is weaker for debugging *flakiness* specifically:

- **No per-scenario timestamp** — only run-level `startedAt`/`endedAt`
  (`schemas.ts:362-385`); scenario timing can only be inferred from
  cumulative `latencyMs` in file order.
- **No retry-attempt count recorded**, even for the one place retries
  happen (the judge's `withRetry`).
- **No raw request/response payload persisted into results.** The only
  raw-HTTP capture is `DEBUG_LLM_HTTP=1` (`provider-factory.ts:11-38`),
  which logs to stdout/your own log redirection, not into
  `eval-results/`, and — critically — **only wraps the `openai`-type
  client** (`docs/App-Docs/Evaluations.md:188-189` confirms Ollama and
  Anthropic use different client libraries this hook doesn't cover). This
  means there is **no raw-transport debug capability at all for the
  Ollama/M1 leg** of the setup, which is also the leg with no
  harness-level timeout (§2.2) — the one provider most likely to hang
  silently is also the hardest one to diagnose after the fact.

### 2.6 Documentation drift

`docs/App-Docs/Evaluations.md` is accurate for CLI usage, scenario types,
and suite discovery, but:

- Never mentions `eval-baselines.yaml` or the baseline skills at all — a
  reader of only this doc would not know the project's actual answer to
  "is this score a regression" exists.
- Its "Available Suites" table (lines 84-93) lists 8 suites; there are
  actually 27 files under `suites/*.yaml`. The doc does state new suites
  need no registration to run, so this isn't a functional bug, but the
  one doc meant to state coverage intent is stale for roughly two-thirds
  of the real suite set.
- Says nothing about temperature/seed/determinism, consistent with there
  being no such controls to document, but it also means a reader hitting
  flaky results has no documented explanation or knob to reach for.

### 2.7 Test coverage of the harness itself

`lib/evaluations/test/unit/` covers `comparator`, `failure-category`,
`loader`, `malformed-tool-call`, `runner`, `schemas`, `serializer`,
`store`, and the `deterministic`/`structured`/`tool-call`/`tool-sequence`
executors individually. **`executors/llm-judge.ts` and
`executors/semantic.ts` have no dedicated test file** — their logic
(prompt construction, retry wiring, embedding call + cosine similarity
math) is exercised only indirectly through `runner.test.ts`'s mocks at the
`executeScenario` boundary, which control the model's return value
directly rather than exercising the judge's own prompt-building or retry
configuration. Per this repo's own AGENTS.md testing policy ("does this
file do any processing?" — yes, for both files), these two executors
should have adjacent unit tests and currently don't.

---

## 3. Eval automation (skills) findings

Scope: `.agents/skills/auto-eval-loop/`, `.agents/skills/auto-eval-pr-comment/`,
`.agents/skills/auto-update-baseline/`.

### 3.1 `auto-eval-loop` acts on a single run

The loop's documented sequence (`SKILL.md:189-231`) runs a suite once per
model per round, reads that one result, and goes straight to diagnosis and
a code/prompt edit. **There is no step anywhere that reruns a
scenario/model under identical conditions before concluding a failure is
real.** The only repetition is a cross-round "does this keep failing in
the same shape" plateau check (`SKILL.md:244-255`) — comparing rounds that
already have a code change between them, which is a shape-based
ceiling-vs-bug heuristic, not a same-conditions resample. Given the
repo's own documented ~57% (4/7) run-to-run variance on at least one
scenario, a single failing round is frequently indistinguishable from
pure sampling noise by this loop's own logic, yet it will still diagnose,
edit, and commit against it.

### 3.2 Variance is computed in exactly one place, and it's disconnected from the other two

`auto-update-baseline` is the only one of the three skills that averages
multiple rounds (5, by default) into a score — but it stores only the
mean (`score`), with no stdev/min/max field in the schema at all, and that
baseline file is never consulted by `auto-eval-loop` or
`auto-eval-pr-comment` when deciding pass/fail or reporting results. The
one place in this automation layer that acknowledges variance is not
connected to the two places that act on and report single-run results.

### 3.3 Judge consistency is checked nowhere

Across all three `SKILL.md` files and their helper scripts, the judge
model is treated as just another config value. There is no re-judging of
the same transcript, no judge-vs-judge cross-check, and no judge-agreement
metric anywhere in this layer.

### 3.4 `auto-eval-pr-comment` reports single-run numbers as definitive

The comment format (`references/comment-format.md:55-62`) presents raw
per-round `passed/total` numbers with no variance caveat and no reference
to `eval-baselines.yaml`'s own documented sampling variance. The skill is
faithful to what's in the log (`SKILL.md:117-122`), but the log itself
only ever contains single-run scores, so faithful transcription still
reports noise as signal.

### 3.5 Confirmed bug: the audit trail isn't actually getting committed

`auto-eval-loop`'s commit step instructs `git add
api/src/agents/system-prompt.ts api/src/agents/system-prompt.test.ts
eval-logs/auto-eval-<timestamp>.yaml` (`SKILL.md:265`). `eval-logs/` is
gitignored (`.gitignore:163`), and `git add` on a path under an ignored
directory exits non-zero rather than silently staging it. As written, this
step fails every round — the skill never passes `-f`, and nothing flags
the contradiction. `auto-eval-pr-comment` describes this log file as "the
only durable, reviewable record of the loop" — which, following
`auto-eval-loop` as documented, is never actually committed.

### 3.6 Not integrated into CI

`.github/workflows/*.yml` contains zero references to any of the three
skills, `npm run eval`, or `eval-baselines.yaml` (verified by grep across
all four workflow files). These skills are 100% manual/interactive —
there is no scheduled or PR-gated regression check anywhere in CI.

### 3.7 Minor state-consistency notes

- `nextRunId` in an `auto-eval-loop` audit log is hand-incremented by the
  agent with nothing enforcing it matches the log's actual `runs:`
  contents — a crash between appending a round and incrementing this
  field could silently desync it.
- A skill doc citation drift was found (`auto-eval-pr-comment/SKILL.md:26`
  cites `.gitignore:157` for where `eval-logs/` is ignored; the actual
  current line is `163`) — minor on its own, but it's evidence the skill
  docs aren't being kept in lockstep with the files they describe.

---

## 4. Eval suite quality & coverage

Scope: all 27 files under `suites/*.yaml`, cross-referenced against
`api/src/agents/*` for real tool/prompt coverage.

### 4.1 What's working well

This is worth stating plainly, not just as a courtesy: the suite corpus is
better engineered than a typical first pass at LLM evals.

- Nearly every scenario carries a specific, real `purpose` field, not
  filler.
- `wiki-navigation.yaml`, `wiki-write.yaml`, `wiki-lint.yaml`,
  `web-fetch.yaml`, and `explicit-tool-syntax.yaml` all show genuine
  iterative tuning backed by real failure transcripts, with confirmed
  per-model capability ceilings explicitly called out and *not* chased
  further once confirmed (e.g. `wnav-004`/`wnav-009` for Ornith/Lemonade,
  `system-prompt.ts:243-260, 600-659, 700-719`).
- `instruction-hierarchy-preferences.yaml` exists specifically as a
  positive control for `instruction-hierarchy.yaml`'s adversarial suite
  (catching a guard that's *too* broad, not just one that's too narrow),
  and both it and `scheduled-task-runs.yaml` use held-out scenarios
  (`ihp-003`, `str-003`/`str-004`) specifically to distinguish "the rule
  generalizes" from "the model memorized the worked example."
- `wiki-search.yaml`'s `ws-002` comment (lines 33-46) documents an actual
  controlled experiment proving embedding-similarity scoring was unusable
  for that scenario — a correct answer scored 0.03-0.11 cosine similarity
  against the configured embedding backend while an unrelated answer
  scored 0.54, comfortably above any workable threshold. This is the
  rare case of a team proving a scoring method doesn't work with numbers
  instead of a guess, and switching to `llm-judge` as a result.
- `ambient-context.yaml` and `workspace-chat-context.yaml` have the
  best-anchored `llm-judge` rubrics in the corpus — binary, unambiguous
  ("Score 10 if X. Score 0 if Y.") against a pinned simulated context, so
  there's a single objectively correct answer.

### 4.2 Rubric-shape flakiness: a known fix that was never propagated

`wiki-navigation.yaml`'s `wnav-005` (lines 101-174) found, and fixed, a
specific rubric-design bug: an unweighted multi-criteria rubric with a
bare `minScore: 6` and no hard gate produced scores that straddled the
pass/fail threshold for near-identical, equally-compliant answers (8 then
6 across consecutive rounds, per the scenario's own comment). The fix was
a hard floor ("score ≤3 if the core requirement is missing") plus an
anchored example pinning any compliant answer to ≥8.

**That fix was never propagated to the sibling scenarios with the
identical rubric shape.** Confirmed instances of the same unweighted
multi-criteria + bare `minScore: 6` + no hard gate pattern:

- `wiki-write.yaml`: `wwrite-005` (lines 234-278), `wwrite-010` (lines
  280-318)
- `task-plan-generation.yaml`: `tpg-002`/`tpg-003`/`tpg-004` (lines
  42-123)
- `thread-titles.yaml`: `tt-004` (89-118), `tt-005` (129-159), `tt-006`
  (161-194), `tt-007` (196-223)
- `workspace-summary.yaml`: `wsum-001` (24-63), `wsum-002` (65-99),
  `wsum-004` (128-162)

This is a mechanical, low-risk fix — apply `wnav-005`'s pattern (hard
gate + anchored example) to each of the roughly nine scenarios above.

### 4.3 `provider-compatibility.yaml` doesn't test what it's billed to test

AGENTS.md calls this suite "the recommended first suite to run against a
new model/provider pairing," and its own purpose text says a failure here
"means the provider/server can't reliably emit structured tool calls...
investigated before trusting results from any other suite against the
same provider" (`suites/provider-compatibility.yaml:4-12`). Given this
project's actual providers (Ollama, Lemonade/llama.cpp, DigitalOcean
serverless):

- **Tool-calling transport is covered reasonably well**: zero-arg call,
  single string arg, nested object arg, multi-turn follow-up, structured
  `ask_user` vs. prose (`pc-001` through `pc-005`).
- **Structured output (`withStructuredOutput()`) has zero coverage.**
  There is no `type: structured` scenario in this suite, yet
  `after-agent.yaml`, `task-plan-generation.yaml`, and the production
  `loop-reflection.ts` call all depend on structured output working — a
  genuinely separate provider capability from tool-calling that
  llama.cpp-family servers in particular often support with different
  reliability than tool-calling. A provider could pass this suite 5/5 and
  still fail every structured-output-dependent suite for transport
  reasons indistinguishable from a model-reasoning failure — exactly the
  confusion this suite exists to prevent, left unprevented for this one
  capability.
- **Context length has zero coverage.** No scenario sends anything
  approaching a long prompt; the largest input is a one-line sentence.
  Given local models are frequently run with small context windows, and
  `rlm.yaml`/`web-fetch.yaml` seed multi-KB documents that are routine in
  production, there's no check for truncation or degraded behavior on a
  long input before trusting the rest of the suite set against a new
  provider.

Given the user's actual multi-provider setup, closing these two gaps in
`provider-compatibility.yaml` is the highest-value content fix available.

### 4.4 Stale or misleading content

- `thread-titles.yaml`'s `tt-003` (line 73) is the only other surviving
  `type: semantic` scenario in the corpus besides the one `wiki-search.yaml`
  already proved unreliable via `ws-002`'s experiment — and nobody has
  re-run that diagnostic against `tt-003` to check whether the same
  length/format-dominated-scoring problem applies there.
- `tool-calling.yaml`'s `tools-001`/`tools-002` assert on `generate_image`,
  which is not a real production tool — it exists only as an eval fixture
  (`bin/eval-fixtures.ts:10-18`, explicitly commented "eval fixture, never
  meant to execute"). This is honestly documented in `bin/eval.ts:54-61`,
  but a suite-only reader would reasonably assume image generation is a
  real capability under test; it is not, and nothing in the suite
  clarifies that inline.
- `instruction-sensitivity.yaml` is framed around resolving an open
  "Option A vs. Option B" design decision (lines 98-104: "THE KEY
  SCENARIO... Fail = Option B required"), but `api/src/agents/system-prompt.ts:978-1067`
  shows that decision already appears resolved in code. The suite still
  functions as a valid regression guard, but its framing reads as if the
  decision is still open and should be confirmed/re-framed.
- `docs/App-Docs/Evaluations.md`'s suite table (see §2.6) is stale for
  19 of the 27 real suite files.

### 4.5 Zero-coverage capabilities

Cross-referencing `api/src/agents/tool-catalog.ts`, `chat-agent.ts`'s
`STATIC_CHAT_TOOLS`/`WAKEUP_TOOLS`, and every standalone prompt-producing
module under `api/src/agents/` against every suite file surfaced real
capabilities with **no suite coverage at all**:

- `cancel_wakeup` — `agent-wait.yaml` thoroughly tests `schedule_wakeup`
  but never the agent actually canceling a scheduled wake.
- `search_conversation` — unconditionally available in
  `STATIC_CHAT_TOOLS`, untested by any scenario.
- `spawn_sub_agent` — unconditionally available, including its
  nesting-restriction guarantee (a sub-agent can't itself call
  `spawn_sub_agent`/`ask_user`) — untested at the eval level.
- `wiki_create_domain` — real tool, referenced in zero suites.
- **The entire wiki-ingestion agent** (`api/src/agents/wiki-ingestion-agent.ts`,
  `wiki-ingestion-system-prompt.ts`) — every *other* standalone production
  prompt in this codebase has its own suite that targets it directly
  (`after-agent.yaml` ↔ `after-agent.ts`, `thread-titles.yaml` ↔
  `threads.handlers.ts`, `task-plan-generation.yaml` ↔
  `plan-generation.ts`, `workspace-summary.yaml` ↔
  `workspace-summarizer.ts` — all four explicitly set
  `appliesHarnessSystemPrompt: false` for this reason). The wiki-ingestion
  agent's own prompt and tool choices have no suite at all, despite fitting
  the exact pattern `docs/App-Docs/Evaluations.md:98-107` describes as the
  one to follow.
- **`loop-reflection.ts`'s actual judgment function** (`evaluateLoopProgress`)
  — `loop-guard.yaml` only tests whether the *chat agent* follows injected
  reflection guidance, which its own comment calls "a representative
  stand-in" for what this function would really produce
  (`loop-guard.yaml:81-94`). Nothing tests whether `evaluateLoopProgress`
  itself correctly judges convergence or writes useful guidance against a
  real model.
- **`lib/rlm`'s own internal reasoning loop** — `rlm.yaml` only ever tests
  whether the chat agent *decides* to delegate to `rlm_query` (every
  `rlm_query` result in the suite is pre-seeded, confirmed architecturally
  unavoidable per ADR-001, `rlm.yaml:70-81`). Whether RLM's own
  peek/grep/final_answer loop actually finds the right answer in a corpus
  the top-level model can't see directly is entirely untested.
- Live multimodal image analysis in an initial turn (as opposed to the
  image re-fetch/notation path `get-tool-key.yaml` covers) has no
  coverage — possibly a structural limitation of a text-based eval
  runner, in which case it should be stated explicitly as out of scope
  rather than left looking like an oversight.

---

## 5. Root cause summary

Two fixes address nearly everything in sections 2 and 3:

1. Wire `temperature`/`seed` into `provider-factory.ts` for all three
   provider types, defaulting to near-zero for anything feeding automated
   scoring.
2. Make `--judge-model` required (hard failure, not a silent fallback).

Everything else catalogued — 5-round baseline averaging, n=1 diagnosis in
`auto-eval-loop`, per-model ceiling notes scattered through
`system-prompt.ts`, the suite-level rubric gates added to `wnav-005` — is
the team working around the consequences of these two gaps rather than
closing them. Fixing the source is expected to make the rest of this list
meaningfully cheaper to execute, because a large share of the remaining
work is "figure out whether this result is signal or noise" — a question
that gets much easier to answer once both calls are seeded and the judge
is guaranteed independent.

---

## 6. Recommended priority roadmap

**P1 — Root cause (do first; everything downstream depends on this)**
1. Add `temperature`/`seed` fields to `ProviderSchema` and wire them into
   all three `createProviderFromConfig` branches; default to 0 (or near-0)
   for eval runs specifically, for both the target model and the judge.
2. Make `--judge-model` required in `bin/eval.ts`, or at minimum fail
   loudly (non-zero exit, prominent warning) instead of silently
   defaulting to the model under test.

**P2 — Re-baseline and harden the harness**
3. Re-run `/auto-update-baseline` across all suites × all 4
   provider/model slugs once P1 lands — the current baseline numbers were
   measured under noisy sampling conditions and should be treated as
   provisional, not wrong.
4. Extend the baseline schema to record spread (stdev/min/max), not just
   the mean.
5. Wire an actual regression check against `eval-baselines.yaml` —
   ideally a CI step; at minimum, have `auto-eval-loop`/
   `auto-eval-pr-comment` read it before treating a single run's score as
   signal.
6. Add retry-on-transient-error for target-model invocation (currently
   only the judge retries).
7. Wire a timeout for the Ollama provider path (even a manual
   `Promise.race`, given `ChatOllama` has no constructor option for it).
8. Add per-scenario timestamps, judge retry-attempt counts, and raw-request
   capture uniformly across provider types (not just `openai`-type) to
   `ScenarioResult`.
9. Add unit tests for `executors/llm-judge.ts` and `executors/semantic.ts`
   per this repo's own testing policy.
10. Update `docs/App-Docs/Evaluations.md`: document the baseline
    mechanism, refresh the suite table to the real 27 suites.

**P3 — Automation layer**
11. Require at least 2 consecutive failing rounds under identical
    conditions before `auto-eval-loop` diagnoses/edits/commits against a
    scenario as a real failure.
12. Fix the `auto-eval-loop` commit step so the `eval-logs/` audit trail
    is actually committed (force-add with a clear justification, or stop
    describing it as committed).
13. Have `auto-eval-pr-comment` report results with the matching
    `eval-baselines.yaml` entry for context, not as a standalone number.

**P4 — Suite content**
14. Propagate `wnav-005`'s hard-gate rubric pattern to the ~9 sibling
    scenarios listed in §4.2.
15. Add `structured`-type and long-input/context-length scenarios to
    `provider-compatibility.yaml`.
16. Re-run `ws-002`'s embedding-similarity diagnostic against
    `thread-titles.yaml`'s `tt-003`; convert to `llm-judge` if it fails
    the same way.
17. Clarify inline in `tool-calling.yaml` that `generate_image` is a
    fixture-only hypothetical, not a real tool.
18. Confirm whether `instruction-sensitivity.yaml`'s Option A/B framing is
    still an open decision or should be re-framed as pure regression
    coverage.
19. Add suite coverage for `cancel_wakeup`, `search_conversation`,
    `spawn_sub_agent`, `wiki_create_domain`, and the wiki-ingestion agent's
    own system prompt.
20. Decide and document explicitly whether `lib/rlm`'s internal loop and
    live multimodal image analysis are in scope for this harness; if not,
    say so rather than leaving them looking like oversights.

This list is intentionally ordered so that P1 is small, contained, and
unblocks confident interpretation of everything that follows — the rest
of the list is real but lower-leverage work that becomes easier to
prioritize correctly once the harness itself stops injecting noise into
every other decision.
