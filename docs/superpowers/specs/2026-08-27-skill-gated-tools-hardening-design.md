# Hardening the Skill-Gated Tools pattern

Follow-up to [`2026-08-26-chat-workspace-project-creation-skills-design.md`](2026-08-26-chat-workspace-project-creation-skills-design.md),
folded into PR #101 (the same branch that introduced the pattern) rather than
shipped separately, since the PR was still open when these gaps surfaced.

## Problem

A post-merge coverage review of the Skill-Gated Tools pattern
(`skill-expansion.middleware.ts` + `skill-gated-tools.middleware.ts`) found
two real gaps:

1. **Stale gate on skill switch.** `skillExpansionMiddleware.beforeAgent`
   only writes `activeGatedSkill` when the latest human message matches a
   _registered gated_ skill command. A non-gated or unrecognized command
   leaves the field untouched, so a gate opened by an earlier
   `/create-workspace` can leak into an unrelated skill invoked afterward in
   the same thread.
2. **Gating is untested against a real model.** `bin/eval.ts` binds a
   single static tool list per suite and calls `model.bindTools(tools).invoke(...)`
   directly — it never runs `skillExpansionMiddleware` or
   `skillGatedToolsMiddleware`. `suites/create-workspace-project.yaml`'s own
   purpose note says as much. Digging into why surfaced a second, more
   fundamental issue: for `tool-sequence` scenarios
   (`cwp-003`/`004`/`006`/`007`), the seeded conversation history
   (`buildSeededMessages`) never includes a `/create-workspace` turn at all,
   and `buildSystemPrompt()` never mentions skills — so `default-skills.ts`'s
   prose, the thing three rounds of the auto-eval loop (`aad820f`, `e7bdad0`,
   `9c20716`) iteratively edited, was **never in the model's context** for
   those four of the suite's seven scenarios. The round-over-round score
   movement the loop reported is at least as consistent with sampling
   variance (which its own PR comment already admits for `cwp-001`/`002`) as
   with the prose edits actually mattering. `create-workspace-project.yaml`
   doesn't yet test what it claims to.

## Fix 1: clear the gate on every skill invocation

`skill-expansion.middleware.ts` changes from "set `activeGatedSkill` only
when the matched command is gated" to "every successful skill expansion
explicitly sets it" — to the matched command when it's gated, to `null`
otherwise (including an unrecognized command). A plain-chat message (no
leading `/`) still leaves the field untouched entirely, unchanged from
today — that's load-bearing, not an oversight: the multi-turn
field-collection flow (ask → user replies in plain text → confirm → create)
and tool retry after a rejection both depend on the gate staying open across
non-slash-command turns. Abandoning a gated flow via plain chat (no new
slash command ever typed) still leaks the tool for the rest of the thread —
accepted as residual risk, not fixed here; the two legitimate uses of that
same behavior (mid-flow continuation, post-rejection retry) make a
turn-count/TTL heuristic collateral damage waiting to happen, and a
correctness fix would need a signal the middleware doesn't have.

## Fix 2: real gating + real skill text in the eval harness

**Shared registration source.** `GATED_SKILL_REGISTRATIONS` moves out of
`chat-agent.ts` (unexported, and pulling in that file's full import graph —
`tools-manager`, `provider-factory`, etc. — is unwanted for a two-item
array) into a new `api/src/agents/gated-skill-registrations.ts`, exporting
`GATED_SKILL_REGISTRATIONS: SkillGatedToolRegistration[]`. `chat-agent.ts`
imports it as before; `bin/eval.ts` imports the same array plus
`createSkillExpansionMiddleware`/`createSkillGatedToolsMiddleware` (already
exported, already side-effect-free) to build its own middleware instances
for eval runs — the real production registrations and the real production
middleware logic, not a reimplementation.

**New optional scenario field: `gatedSkill?: string`**, added to
`ToolCallScenarioSchema` and `ToolSequenceScenarioSchema`
(`lib/evaluations/src/schemas.ts`). When a scenario sets it (e.g.
`gatedSkill: create-workspace`), `runner.ts`:

1. Resolves `activeGatedSkill = gatedSkill` for that scenario.
2. If the scenario's `input` is itself a literal slash command matching that
   skill (`/create-workspace ...` — a "fresh invocation" scenario, e.g.
   today's `cwp-001`), runs it through the real
   `skillExpansionMiddleware.beforeAgent` first. The model sees the **live**
   `default-skills.ts` body instead of hand-typed paraphrase text, and
   `activeGatedSkill` is confirmed from the real expansion rather than
   trusted blindly from the YAML field.
3. If `input` is plain text ("continuation" scenarios — today's
   `cwp-003`/`004`/`006`/`007`, where the invocation happened in a turn the
   seeded history doesn't literally replay), trusts `gatedSkill` directly as
   the resolved state. There's no earlier slash-command turn to re-derive it
   from, and production's own middleware only re-expands the _latest_ human
   message per turn anyway — this matches real turn-by-turn behavior rather
   than inventing a fuller simulation the scenario schema doesn't otherwise
   support.
4. Either way, calls the real
   `skillGatedToolsMiddleware.wrapModelCall({ tools: scenarioTools, state: { activeGatedSkill } }, handler)`
   before the model call, where `scenarioTools` is already narrowed by any
   `excludeTools` and `handler` is the existing `invokeToolCallModel`. The
   model only sees `create_workspace` when the gate the real middleware
   computes says it should.

Omitting `gatedSkill` (every other suite, and any non-gated scenario)
preserves today's behavior exactly — full static tool list, no middleware
involved. Fully backward compatible; no suite besides
`create-workspace-project.yaml` needs to change.

**Retrofit `create-workspace-project.yaml`.** `cwp-001`/`002`/`005` get
`gatedSkill` set and their `input` simplified to the literal slash command,
dropping the hand-typed paraphrase now that real expansion supplies it.
`cwp-003`/`004`/`006`/`007` get `gatedSkill` set to carry the resolved gate
state into filtering. All seven now exercise the real mechanism end to end;
none need new assertions since `runToolCall`/`runToolSequence` already
check "was the (now genuinely gated) tool actually called."

## Testing

- `skill-expansion.middleware.test.ts`: two new cases — invoking a second
  gated skill clears the first's tool; invoking a non-gated skill after a
  gated one clears `activeGatedSkill` to `null`.
- `lib/evaluations`: new coverage for the `gatedSkill` branch in
  `runner.ts` — a scenario with it set filters tools via the real
  middleware pair; a scenario without it is unaffected (regression guard
  for every other suite).
- Real run: `npm run eval -- --suite create-workspace-project --model <local provider>`
  against the retrofit. This is the actual proof gap 2 asked for — a live
  model, with the tool genuinely absent/present depending on gate state,
  and the current `default-skills.ts` prose actually in context for the
  invocation scenarios. May fail once or twice before `default-skills.ts`
  (or, per the finding below, a tool schema description) needs a real
  adjustment — same as the original loop, except the scores will mean what
  they claim to this time.
- `npm test` / `npm run lint` / `npx prettier --check .` before pushing, per
  repo convention.

## Out of scope / non-goals

- Plain-chat abandonment of a gated flow — accepted residual risk (see Fix
  1); no heuristic added.
- Proving `buildChatAgent`/`buildWorkspaceChatAgent` wire the two
  middlewares together correctly, in the right order, in the actual
  production graph. This design proves the _mechanism_ behaves correctly
  against a real model when driven correctly; it doesn't prove the real
  agent-build code drives it correctly. No test in the repo currently
  exercises `buildChatAgent`/`buildWorkspaceChatAgent` at all — worth a
  follow-up issue, not blocking this one.
- The `wikiId` tool-schema-description finding: `cwp-003`'s original
  failures (reasoning that `wikiId` was required and detouring to find one)
  may stem from `create_workspace`'s own Zod field description — visible to
  the model via `bindTools` independent of any skill prose — rather than
  from `default-skills.ts`'s wording. Not prescribing a fix here; the
  real eval run after this retrofit will show whether it's still live
  before touching `create-workspace.tool.ts`.
