# Writing Evals

This is a guide to **authoring** scenarios in this directory. For running evals (CLI flags,
determinism, baselines, exit codes), see [`docs/App-Docs/Evaluations.md`](../docs/App-Docs/Evaluations.md) —
this document doesn't repeat that material. The schema in
[`lib/evaluations/src/schemas.ts`](../lib/evaluations/src/schemas.ts) is the authoritative
source of truth for every field below; it's `.strict()`, so a typo'd or misplaced field fails
loudly at load time rather than being silently dropped. When this guide and the schema disagree,
the schema is right — it changes faster than prose does.

Every file here is one suite: a YAML document with a `suite:` block and a `scenarios:` list.
Suites are auto-discovered by directory scan — dropping a new `suites/whatever.yaml` requires no
registration anywhere.

## Before writing a scenario: EDD

This project practices **Evaluation-Driven Development**. The house rules (full text in
`AGENTS.md`):

1. Before implementing a new LLM-facing feature, write a failing scenario first
   (`npm run eval:new -- --suite <id>`), then implement until it passes.
2. When filing a bug involving LLM output, add a failing scenario that reproduces it *before*
   the fix — id it `bug-<issue#>-<short-description>` (e.g. `bug-42-agent-refuses-tool-call`).
3. A bug fix isn't mergeable until its reproduction scenario is green.
4. `purpose` is required on every scenario and must answer *why this matters*, not just restate
   what it tests (see "Writing `purpose`" below).
5. **You probably can't run the eval yourself.** An agent session typically has no network path
   to the local providers (Ollama, Lemonade, etc.) these suites target. Write the scenario, then
   hand off the exact command to the user — never report a scenario as passing without having
   seen real output.

## Picking a scenario `type`

This is the decision that most determines whether a scenario will actually measure what you
intend. Six of the seven types bind no tools at all — only `tool-call` and `tool-sequence` do.

| Type | Use when... | Binds tools? |
|---|---|---|
| `deterministic` | The correct output is a fixed string, substring, or pattern. | No |
| `semantic` | ⚠️ Avoid by default — see below. | No |
| `llm-judge` | You're scoring *prose quality* in a response that is already past any tool-calling decision. | No |
| `structured` | The production code path calls `model.withStructuredOutput()` and you're checking fields of the parsed object. | No |
| `tool-call` | You're asserting *which tool* the model calls (and optionally its arguments) on a fresh turn. | Yes |
| `tool-sequence` | Same as `tool-call`, but the model needs to react to a conversation already in progress. | Yes |
| `human` | The judgment is subjective enough that no rubric should stand in for a person. | No |

**The rule that matters most: if a scenario is really about which tool gets called, it must be
`tool-call`/`tool-sequence`, never `llm-judge`.** `llm-judge` never binds tools — the model is
only ever asked to produce a text reply, so a rubric like "did the model pick the right command"
is literally unobservable to it. Worse, a tool-trained model that *wants* to call a tool it
hasn't been given will sometimes fall back to writing a pseudo-tool-call as prose (e.g.
`<wiki_locate><query>...</query></wiki_locate>`), which tanks a judge score for reasons that have
nothing to do with your rubric. Two real examples from this repo:

- `shell-execution.yaml`'s `se-005` was originally `llm-judge`, scoring "did the agent prefer the
  safe command" — both models under test scored 0 by refusing, because the judged behavior (which
  command gets picked) can't be observed without a bound tool. Restructured as `tool-call` with
  three `contains` arg checks at `minScore: 0.3` (any one of `cat`/`head`/`tail` passes).
- `wiki-navigation.yaml`'s `wnav-005` seeds two prior tool turns (`wiki_locate` *and* `wiki_search`
  both returning no match) specifically so the model has no reasonable tool call left to want —
  only then is the honest-prose judgment it's actually testing clean of that confound.

**`semantic` (embedding similarity) is a known-risky type here — don't reach for it as a default.**
`wiki-search.yaml`'s `ws-002` documents a controlled experiment where a genuinely correct answer
scored 0.03–0.11 cosine similarity against this repo's configured embedding backend, while an
unrelated answer scored 0.54 — the suite switched to `llm-judge` as a result. Only two `semantic`
scenarios remain in the whole corpus; prefer `llm-judge` or `deterministic` unless you've verified
the embedding backend actually separates correct from incorrect answers for your phrasing.

## Writing `purpose`

`purpose` isn't a restatement of the scenario's mechanics — it's an audit trail. The dominant
style in this codebase cites the specific auto-eval round/date/model that surfaced the problem,
what the scenario originally asserted if it changed, and *why* it was reshaped rather than just
deleted when a prior assertion turned out to be wrong. This is what makes a scenario legible
months later without re-deriving the reasoning from scratch. Compare:

```yaml
# Weak — just restates the type:
purpose: Checks that the agent calls wiki_locate.

# House style — explains the stakes and the history:
purpose: >
  Given a wiki_locate call that already returned no match, the agent must say
  so plainly instead of fabricating an answer from an unrelated domain.
  Deliberately seeded (not cold) — this scenario owns synthesis quality (is
  the final text honest, given a completed search), not tool-orchestration
  (does the model decide to search at all, which is wnav-007's job).
```

When you reshape an existing scenario, leave a comment explaining the "round 1 was X, it failed
because Y, restructured as Z" trail — see `shell-execution.yaml`'s `se-005` for a worked example.

## Scenario id convention

`<suite-prefix>-<number>[-letter]-<kebab-description>`, e.g. `wnav-005-no-match-reports-honestly`,
`se-007-multi-step-task`, `cs-001-confirms-before-creating`. For a bug reproduction, use
`bug-<issue#>-<short-description>` instead. A few older suites use bare `E-##`/`GTK-###` ids —
legacy, not a pattern to copy.

## Field reference by type

Every scenario has the base fields `id`, `name`, `purpose` (all required), plus optional `skip`
(never runs it; excluded from pass-rate math) and `excludeTools` (an array of tool names to
remove from the bound tool list for this scenario only, simulating a session where they aren't
registered).

### `deterministic`

```yaml
type: deterministic
input: 'How do I configure a provider?'
match: contains   # contains | exact | regex
expected: 'provider'
```
`exact` trims both sides before comparing; `regex` does `new RegExp(expected).test(output)`.

### `semantic` (avoid by default — see above)

```yaml
type: semantic
input: '...'
expectedSimilarTo: '...'
minSimilarity: 0.75   # default
```
Requires `embeddings.enabled: true` in `config/config.yaml`.

### `llm-judge`

```yaml
type: llm-judge
input: '...'          # or turns: / steps: — see below
rubric: >
  Free text describing what a correct answer looks like.
minScore: 7            # 0-10 scale, default 7
```
**Write a hard gate before any weighted scoring**, e.g. *"Score no higher than 3/10 if X is
missing. Given X is met, score 8+ — extra polish is a bonus, not a requirement."* An unweighted
multi-criteria rubric with a bare `minScore` is a confirmed source of flaky straddling scores (the
same compliant answer scoring 8 one run and 6 the next). Anchor the rubric the way `wnav-005`
does, not the way an unweighted checklist does.

### `structured`

```yaml
type: structured
input: '...'
outputSchema: { ... }      # JSON-Schema-shaped object, passed to withStructuredOutput()
fieldChecks:
  - path: shouldWrite        # dot-path into the parsed object
    match: equals            # equals | contains | exists | oneOf | gte | between
    value: true
minScore: 1                  # fraction of fieldChecks that must pass; default 1
```
`match` semantics: `equals` is `===`; `contains` is substring or array-includes; `exists` checks
not-`undefined`/`null` (no `value` needed); `oneOf` checks `value` (an array) includes the actual
value; `gte` is `actual >= value` (both numbers); `between` takes `value: [min, max]` inclusive.

### `tool-call`

```yaml
type: tool-call
input: '...'
tool: wiki_search            # a '!' prefix negates: '!create_tasks' passes iff NOT called
argChecks:                   # optional — same match semantics as structured's fieldChecks
  - path: query
    match: exists
minScore: 1                   # fraction of argChecks that must pass; default 1
gatedSkill: create-skill       # optional — see "Skill-gated tools" below
responseRubric: >              # optional — judges the SAME turn's reply text too
  ...
responseMinScore: 7             # default 7 if responseRubric is set
```
With no `argChecks`, the tool-name match alone decides pass/fail — this is the common case, not
an edge case. For a negated `!tool`, `argChecks` are ignored (nothing to check on the passing
path). `responseRubric` exists for cases the tool assertion alone can't see — e.g. a negated
`!schedule_wakeup` where the model rightly skips the tool but then falsely promises in prose to
do the thing anyway.

### `tool-sequence`

Like `tool-call`, but *requires* `turns` or `steps` (at least one) — it always represents a
conversation already in progress. Use this whenever a scenario needs the model to react to a
prior tool result rather than cold-starting; use `tool-call` if there's nothing to seed.

```yaml
type: tool-sequence
turns:
  - user: 'Generate an image of a red dragon and upload it.'
  - tool: generate_image
    args: { prompt: 'a red dragon' }
    result: { imageBase64: '...', mimeType: 'image/png' }
tool: upload_image
argChecks: [...]
responseRubric: '...'       # optional — can additionally see the final turn's tool call(s),
responseMinScore: 7          # not just its reply text, unlike tool-call's responseRubric
```
A `!tool` negation is also supported here (and only here — `tool-call` scenarios have no seeded
history that would make abstaining the correct answer).

### `human`

```yaml
type: human
input: '...'
rubric: '...'
scoring:
  type: choice   # or: scale (options carry a numeric `value` + top-level `passingScore`)
  options:
    - { key: 'y', label: 'Yes — clear', pass: true }
    - { key: 'n', label: 'No', pass: false }
status: pending   # pending | approved | rejected
```
Under `--ci` these are recorded `skipped` (no model call) and excluded from pass-rate. Otherwise
the model *is* invoked, but scoring is deferred to `npm run eval:review` (interactive, or
`--detached` for a manifest an agent can fill in, submitted with `eval:submit`).

## `input`, `turns`, and `steps` — which types support which

All three are ways of supplying the conversation a scenario runs: `input` is a single string (the
only thing a fresh, cold-start turn needs), `turns` is a fixed seeded history, `steps` is a live
multi-turn exchange. Only three of the seven scenario types accept anything other than `input` —
the schema enforces this per-type in `lib/evaluations/src/schemas.ts`, with the
cross-field combination rules checked separately in `validateScenarioTurns` (`lib/evaluations/src/loader.ts`,
called right after the YAML parses):

| Type | `input` | `turns` | `steps` |
|---|---|---|---|
| `deterministic` | ✅ optional | ✅ optional | ✅ optional |
| `semantic` | ✅ **required** | ❌ | ❌ |
| `llm-judge` | ✅ optional | ✅ optional | ✅ optional |
| `structured` | ✅ **required** | ❌ | ❌ |
| `tool-call` | ✅ **required** | ❌ | ❌ |
| `tool-sequence` | ✅ optional (never sufficient alone) | ✅ optional | ✅ optional |
| `human` | ✅ **required** | ❌ | ❌ |

For the three types that support seeding (`deterministic`, `llm-judge`, `tool-sequence`), the
valid combinations are:

- **`input` alone** — a plain cold-start turn. Valid for `deterministic`/`llm-judge`. **Not valid
  for `tool-sequence`** — a tool-sequence scenario always represents "a conversation already in
  progress," so `input` alone (nothing seeded) is a schema error; use a `tool-call` scenario
  instead if there's nothing to seed.
- **`turns` alone** — fixed seeded history, one real model call at the end. Valid for all three.
- **`steps` alone** — a live multi-turn exchange, no fixed prefix. Valid for all three.
- **`turns` + `steps` together** — `turns` supplies fixed history before the first live step.
  Valid for all three.
- **`input` + `turns`, or `input` + `steps`** — always invalid, on every type. `input` and
  `turns` are two different ways of saying "here is the conversation," so combining them is
  ambiguous; `steps` replaces `input`'s single-turn concept entirely once a scenario goes
  multi-turn. Setting both is a load-time validation error, not a silent override.

`semantic`, `structured`, `tool-call`, and `human` have no `turns`/`steps` field at all — adding
one to a scenario of those types fails immediately, since every scenario schema here is
`.strict()`. If you need a `tool-call`-shaped assertion ("which tool, with which args") but with
prior context already in place, that's exactly what `tool-sequence` is for — it's not an
alternative to `tool-call`, it's the seeded version of it.

### `turns` vs. `steps` mechanics

**`turns`** — a *fixed* list that becomes conversation history before one real model call at the
end:
- `{ user: '...' }` → a `HumanMessage`.
- `{ tool: 'name', args: {...}, result: {...} }` → a synthetic tool-call + tool-result pair.
  **`result` must be an object**, not a bare string — wrap a real tool's string output as
  `{ text: '...' }` by convention.
- The list **must open with a `{ user }` entry** — some providers' chat templates reject a
  conversation that opens with an assistant tool call.
- A reply can be placed *after* the tool turn it's actually answering, rather than always first.

**`steps`** — an ordered list of *live* turns: the model is actually invoked once per step (the
last step is scored by the scenario's own top-level fields, exactly like a plain `input`
scenario). Each step is `{ user: '...', assert?: {...}, mocks?: { toolName: {...} } }`:
- `assert` is optional per intermediate step, checked independently (narrowed to that type's
  fields, e.g. just `{ tool, argChecks, minScore }` for tool-sequence).
- If a step's live response includes a tool call, `mocks` (keyed by tool name) supplies the
  synthetic result fed back so the conversation continues. **An unmocked tool call is a scenario
  error, not a silent no-op.**
- Continue-on-failure: one step's assertion failing doesn't stop later steps; the scenario only
  passes if every asserted step passed.
- `turns` and `steps` can combine — `turns` supplies fixed history before the first live step.

Every `turns`/`steps` result carries the full seeded+live transcript (`conversation` field) and,
for `steps`, a per-step pass/fail breakdown — both the HTML report and `eval:compare` render them.

## Skill-gated tools: `gatedSkill`

`tool-call`/`tool-sequence` scenarios can set `gatedSkill: <skill-command-name>` (no leading
slash, e.g. `create-skill`) to route through the real
`skillExpansionMiddleware`/`skillGatedToolsMiddleware` pair production uses, instead of the flat
static tool catalog — so the model only sees that skill's gated tools when the skill is genuinely
active. See `create-skill.yaml` for the canonical worked example (nine gated tools, only visible
with `gatedSkill: create-skill` set). Two gotchas learned the hard way there:

- If a turn is meant to be a slash-command invocation, write the **literal slash command text**
  (e.g. `/create-skill called "wiki-search-tips", ...`), not a hand-typed paraphrase — expansion
  only substitutes the actual latest human message, so a paraphrase never triggers it.
- Don't add a separate human "Yes."/confirmation turn after a seeded `ask_user` result —
  answering a real `ask_user` is a graph-level interrupt/resume, not a new top-level human
  message, and adding one also breaks "latest human message" tracking for skill expansion.

## Suite-level fields

```yaml
suite:
  id: wiki-navigation             # used by --suite <id>, NOT the filename
  name: Wiki Navigation
  purpose: >
    Why this suite exists — what regression it guards against.
  passingThreshold: 0.8            # fraction of scored scenarios that must pass; default 1
  appliesHarnessSystemPrompt: true # default true — see below
  simulatedUserInstructions: '...' # optional, see below
  simulatedNow: '2026-10-22T00:00:00Z'  # optional, pins ambient-context's "now"
  simulatedTask: { title: '...', description: '...', outcome: '...', plan: [...] }      # optional
  simulatedWorkspace: { name: '...', location: '...', goal: '...', description: '...' } # optional
```

- **`appliesHarnessSystemPrompt: false`** — most suites implicitly test the live chat agent, so
  the real `buildSystemPrompt()` output is attached before invoking the model, matching
  production. Set this `false` *only* when the suite's `input` fields are already the exact
  production prompt of a **different** code path that never sees the chat harness prompt at all
  (e.g. `after-agent.yaml`, `thread-titles.yaml` — `generateTitleHandler` calls `model.invoke(prompt)`
  directly, with no system message). Don't add this to a new suite unless that exact condition
  holds — it's not a general "make the suite stricter" knob.
- **`simulatedUserInstructions`** — suite-level simulated AGENT.md content, for suites testing
  whether the harness's own tool-routing rules survive an adversarial user instruction telling
  the model to ignore them (see `instruction-hierarchy.yaml`).
- **`simulatedTask` / `simulatedWorkspace`** — mutually exclusive (a scenario models either an
  automated task run or a workspace-chat turn, never both — they're different production
  agent-builder call sites). Setting one renders the *real* `buildTaskContextBlock()` /
  `buildWorkspaceContextBlock()` as the system prompt's context block, so the suite can't drift
  from what production actually sends. These are suite-level, not per-scenario — every scenario
  in the file gets the same simulated context.

## Negative controls and held-out companions

Several suites exist purely to catch a guard that's become *too broad*, not just one that's too
narrow — e.g. `instruction-hierarchy-preferences.yaml` is a positive control for
`instruction-hierarchy.yaml`. Others are reworded companions used to tell "the rule generalizes"
from "the model memorized the worked example" — e.g. `wiki-navigation-heldout.yaml`. If you're
adding one of these: **never tune `system-prompt.ts` against a held-out suite, and keep it out of
the auto-eval-loop** — doing either turns it back into a suite the model has memorized, and it
stops measuring what it exists to measure.

## Known structural limits (don't chase these with wording changes)

- **`lib/rlm`'s internal reasoning loop has no eval coverage, by design.** Any corpus seeded via
  `turns` is visible context to the top-level model, so delegation to a sub-tool can never be
  *forced* or *observed* at this level — from the model's own perspective, reading the seeded
  text directly is simply the better move. `rlm.yaml`'s `rlm-002`/`rlm-003` were deliberately
  restructured from "must call `rlm_query`" assertions into "answer accurately, either path is
  fine" `llm-judge` scenarios once four independent models converged on exactly that. See
  ADR-001. If you're tempted to write a scenario that seeds a large document and expects to force
  delegation to a sub-tool, that's a dead end by design, not a wording problem.
- **No scenario field exists for attaching image content to a turn.** `input`/`turns` are plain
  strings only — there's no way to simulate a multimodal turn today.
- **`llm-judge` can't observe a tool-calling decision** — see "Picking a scenario `type`" above.

## Quick start

```bash
# Scaffold a new scenario into an existing suite (interactive)
npm run eval:new -- --suite wiki-search

# Same, non-interactively (agent-friendly — appends a TODO-marked stub)
npm run eval:new -- --suite wiki-search --detached

# Turn a captured real conversation (good or bad) into a scenario
npm run eval:from-trace -- --trace-id <id> --suite wiki-search

# Run it
npm run eval -- --suite wiki-search --model local --judge-model anthropic

# Sanity-check a new/changed llm-judge rubric against human judgment
npm run eval:calibrate -- --run-id <id>

# Confirm a provider is actually reproducible before trusting a single run
npm run eval:probe -- --suite wiki-search --model local --judge-model anthropic --runs 3
```

`--model`/`--judge-model` are **provider names** from `config/config.yaml`'s `providers[]` list
(e.g. `local`, `Lemonade`, `Ornith`, `Digital Ocean`, `anthropic`), never a raw model id — the
provider entry's own `defaultModel` supplies that. Full CLI reference, determinism/sampling
behavior, baseline regression checks, and output formats are in
[`docs/App-Docs/Evaluations.md`](../docs/App-Docs/Evaluations.md).

`provider-compatibility.yaml` is the suite to run first against any new provider/model pairing —
it's deliberately trivial and transport-focused, so a failure there signals a configuration
problem, not something to fix by tuning a prompt.
