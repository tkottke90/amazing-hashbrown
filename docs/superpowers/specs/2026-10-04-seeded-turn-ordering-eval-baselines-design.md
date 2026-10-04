# Seeded turn ordering, multi-step conversations, and eval baselines

Fixes issue #235 (both (a) the ordering bug and (b) multi-step conversations)
and adds a baseline-tracking file + `/auto-update-baseline` skill, all in one
branch per explicit direction from the repo owner.

**Verification note:** this branch was written in a sandbox where `npm
install` cannot reach the private package registry (`npm.artifacts.
tdkottke.com` 401s on anything not already cached — an environment
credential issue, not a code issue). No compiler, linter, or test runner was
available while writing this. Everything below is reviewed by hand, not by
`tsc`/Mocha/ESLint. **Run `npm run lint`, `npx prettier --check .`, and `npm
test` before merging** — treat this PR as unverified until then.

## (a) Ordering fix

### Schema

`PriorToolTurnSchema` (the seeded tool-call+result pair) is renamed
`ToolTurnSchema` and kept as-is. A new `UserTurnSchema` factory produces a
`{ user: string }` shape, parameterized per scenario type with that type's
own assertion shape (see "Per-type `turns` types" below) — composition over
one generic `{ role, content, meta }` turn, per AGENTS.md.

For `DeterministicScenarioSchema`, `LlmJudgeScenarioSchema`, and
`ToolSequenceScenarioSchema`:

- `priorTurns` is removed.
- `turns: Turn[]` is added — an ordered list of `{ user }` | `{ tool, args,
  result }` entries, replacing the `input` + `priorTurns` split. `turns[0]`
  must be a `{ user }` entry (schema-level `.superRefine`, per the issue's
  "Consider rejecting..." note — some providers' chat templates reject a
  conversation opening with an assistant tool call).
- `input` stays as a plain string for the common no-seeding case (most
  scenarios of these three types never seeded anything).
- Exactly one of `input` / `turns` must be set for `deterministic` and
  `llm-judge` (both optional alone, XOR enforced by `.superRefine`).
  `tool-sequence` requires `turns` unconditionally (it always represents
  "a conversation already in progress" — same requirement `priorTurns.
  min(1)` enforced before).

`turns` is NOT added to `tool-call`/`semantic`/`structured`/`human` — none
of them ever seeded history, and the issue's scope is specifically the three
types that used `priorTurns`.

### `buildTurnMessages()` replaces `buildSeededMessages()`

Old signature: `buildSeededMessages(input: string, priorTurns: PriorToolTurn[])`
always put `input` first. New: `buildTurnMessages(turns: Turn[])` walks the
list in the order given — a `{ tool }` entry becomes the same synthetic
`AIMessage(tool_call)` + `ToolMessage(result)` pair as before; a `{ user }`
entry becomes a `HumanMessage`. One call, one invocation at the end, exactly
like today — this function only fixes order, nothing else. (b) below adds a
second, separate code path for when more than one invocation is needed.

### Migration

For every scenario using `priorTurns` across `suites/*.yaml` (18 files, not
just the issue's affected list), mechanically convert:

```yaml
input: 'X'
priorTurns:
  - tool: foo
    args: {...}
    result: {...}
```

into:

```yaml
turns:
  - user: 'X'
  - tool: foo
    args: {...}
    result: {...}
```

This is order-preserving — `buildTurnMessages(turns)` on the migrated form
produces the exact same `BaseMessage[]` as `buildSeededMessages(input,
priorTurns)` did, for every scenario NOT on the issue's affected list. A
unit test (`runner.test.ts`) asserts this equivalence directly against a
handful of representative migrated scenarios (not all ~40+ — the conversion
is mechanical and uniform, so a representative sample catches a systematic
bug as well as an exhaustive one would).

Done as hand-edits to the YAML source (not a programmatic parse +
re-stringify pass) — several suite files carry hand-written comments
(`rlm.yaml` alone has 56) that a round-trip through the `yaml` package's
`Document` API risks reformatting or dropping, and that risk can't be
checked by hand in this sandbox without a working `yaml` install to test
round-tripping against. A mechanical find-and-replace per scenario is
slower but leaves everything else in each file untouched.

For the issue's actual **affected scenarios** (the ones where `input` is a
reply that answers something later in `priorTurns`), the conversion also
reorders: the reply moves to the end, and a real opening user message is
written for the first turn. Per-suite list is the one in the issue body.

## (b) Multi-step conversations

Separate, additive field: `steps: Step[]`, `.min(2)` (a single step is just
`input`). Added to the same three scenario types as `turns`. A scenario can
set `turns` (fixed pre-history) and/or `steps` (live turns), but not `input`
together with `steps` — `steps` fully replaces the single-input concept for
multi-step scenarios.

```ts
Step = {
  user: string;
  assert?: StepAssertion;        // per-type: tool-shaped / rubric-shaped / match-shaped
  mocks?: Record<string, Record<string, unknown>>;  // toolName -> result body
}
```

### Execution

`turns` (if present) builds the fixed prefix exactly as in (a) — no
invocation happens for it on its own. Then, for each `steps` entry in order:

1. Push a `HumanMessage(step.user)`.
2. Invoke the model (bound to tools for `tool-sequence`, unbound for
   `llm-judge`/`deterministic` — same binding rule each type already uses).
3. Push the model's real response onto the message history.
4. If the response carries tool calls: look up each call's mock in
   `step.mocks`. Missing mock → throw a clear scenario error (nothing to
   feed back, can't continue) rather than hang or silently drop the call.
   Found → synthesize `ToolMessage`s from the mocks and push them too, so
   the next step's invocation sees a valid, complete turn.
5. If `step.assert` is set, score the response now and record a step
   result. If not, this step only advances the conversation.

The **last** step's response is always scored against the scenario's
existing top-level fields (`tool`/`argChecks`/`minScore`,
`rubric`/`minScore`, or `match`/`expected`) — this is "by default only the
last step is asserted" from the issue's Expected Behavior, and it's also
why no scenario needs an `assert` on its last step: the mechanism already
there covers it, so a 2-step scenario with no intermediate checks needs
zero new per-step syntax beyond the `steps` list itself.

### Open design questions, resolved

- **Tool calls during a live step** → per-step `mocks` keyed by tool name,
  the issue's own first-listed option ("fits the existing never make real
  calls in developer tests rule"). No fixture wiki, no stop-and-assert
  alternative implemented.
- **Failure propagation** → continue. Every step runs regardless of an
  earlier step's result; overall `passed` is the AND of the final-step
  assertion and every asserted intermediate step. Chosen because it's what
  the issue's own validation-plan framing favors ("more signal per run")
  and because stopping early would make `eval:compare`'s per-step diff
  (a stated requirement) show gaps instead of a full picture.

### Result shape

`DeterministicDetails`/`LlmJudgeDetails`/`ToolSequenceDetails` each gain an
optional `steps: StepResult[]` — present only when the scenario used
`steps`. `StepResult = { index, actualOutput, latencyMs, passed, score,
details }`, reusing `ScenarioResultDetailsSchema` for `details` rather than
inventing a parallel shape — a step's outcome is structurally the same
"what happened, was it right" shape a whole scenario result already is.

`ScenarioResult` gains an optional `conversation` field: the full
turn-by-turn transcript (`{ role, content, toolCalls? }[]`) actually sent
to and received from the model, populated whenever `turns` and/or `steps`
is used. The HTML report's scenario detail panel and `eval:compare` render
it so a reviewer can see exactly what the model saw at each point — this is
the issue's "the HTML report, result YAML and eval:compare show the full
conversation" requirement. Omitted for plain-`input` scenarios — there's
nothing beyond `scenario.input` + `actualOutput` to show that isn't already
shown.

## Baseline tracking

New git-tracked file, `eval-baselines.yaml` at the repo root (alongside
`TODO_LIST.md`, not under the gitignored `eval-results/`/`eval-logs/` —
the whole point is that this survives, unlike a point-in-time run).

```yaml
baselines:
  wiki-navigation:
    lemonade-glm:
      provider: lemonade
      model: GLM-4.7-Flash
      judgeModel: lemonade-glm
      score: 10.6 # average passedScenarios across rounds
      total: 12 # scoredScenarios — pins the denominator so a baseline
      # doesn't silently go stale when the suite's scenario count changes
      rounds: 5
      updatedAt: 2026-10-04T18:00:00Z
      branch: claude/awesome-hopper-9kpc9c
      commit: a1b2c3d
```

Keyed by suite id, then by a short provider+model slug (not a bare
provider name) — a baseline is meaningless without saying both which suite
and which actual model, matching the issue author's own `Lemonade + GLM
4.7 Flash` / `Ornith + Ornith 1.5` framing. `score` is an **average across N
frozen rounds** (`rounds` records N), not a single run's point score —
these suites have measured, documented sampling variance (see the Sept 14
wiki-navigation design doc's 4/7 flakiness example); a baseline written
from one lucky or unlucky run would misinform exactly the "is this a real
regression" question it exists to answer.

### `/auto-update-baseline` skill

`.agents/skills/auto-update-baseline/SKILL.md`, matching this repo's
existing skill location and the `auto-eval-loop` skill's shape (reuses its
`run-eval-round.sh` helper rather than re-implementing a run-and-parse
loop — composition over a second copy of the same mechanism).

Per the repo owner's explicit direction: the skill does not special-case
"agents can't reach local providers" — it assumes it can run evals, and
**fails fast if `config/config.yaml` is missing**, since that file's
presence is the chosen signal for whether the current environment has
provider access at all. If present, it runs `N` frozen rounds (default 5,
matching the issue's own validation plan) per requested suite/provider/
model, averages `passedScenarios`/`scoredScenarios` across the rounds, and
writes/updates the corresponding entry in `eval-baselines.yaml` with
today's date, the current branch, and the current commit SHA.
