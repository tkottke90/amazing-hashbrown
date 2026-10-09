# Eval Suite Reliability Fixes — Design

**Date:** 2026-10-09
**Issue:** [#275](https://github.com/tkottke90/amazing-hashbrown/issues/275) — Chore: Fix eval rubric flakiness and provider-compat gaps
**Source:** `docs/Design/2026-10-06-eval-system-reliability-audit.md`, §4.1–§4.4, §6 (P4)

## Summary

Six content-only fixes to `suites/*.yaml`, all mechanical applications of a
pattern already proven in this codebase or explicit per the audit's
findings. No harness, agent, or system-prompt code changes — pure suite
content and comments. One PR, one branch.

1. Propagate `wnav-005`'s hard-gate rubric fix to 12 sibling scenarios with
   the identical unweighted-rubric bug.
2. Add a `type: structured` scenario to `provider-compatibility.yaml`.
3. Add a long-input/context-length scenario to `provider-compatibility.yaml`.
4. Convert `tt-003` from `type: semantic` to `type: llm-judge`.
5. Add an inline comment to `tool-calling.yaml` clarifying `generate_image`
   is a test fixture, not a production tool.
6. Reframe `instruction-sensitivity.yaml`'s purpose text from "open design
   decision" to "regression guard," since the decision it describes already
   shipped in `system-prompt.ts`.

### What this does NOT do

Per this repo's EDD rules (`AGENTS.md`), this session has no network path to
the local model providers the suites run against, so it cannot execute
`npm run eval`. Two verification steps the issue's "Expected Behavior"
section calls for need a real run and are handed off to the user, called
out explicitly below rather than silently skipped.

---

## 1. Rubric-gate propagation (12 scenarios)

### The proven pattern (`wnav-005`, already shipped)

An unweighted, multi-criteria `llm-judge` rubric with a bare `minScore: 6`
and no hard gate let two near-identical, equally-compliant answers score 8
then 6 across consecutive rounds on the same model — "straddling minScore
for no behavioral difference" (confirmed in `wnav-005`'s own eval-log
history). The fix, applied here to every sibling:

1. Identify the rubric's **one hard requirement** — the thing that makes a
   response wrong regardless of how well everything else is done.
2. Restructure the rubric into two paragraphs:
   - Paragraph 1: the hard requirement, ending **"Score no higher than 3/10
     if [requirement] is missing/violated."**
   - Paragraph 2: the remaining criteria, ending with an **anchor**: _"A
     response that meets the hard requirement and [secondary checks] has
     done its job: score it 8 or higher."_ Any further bonus criteria
     (offering extra help, etc.) are called out as explicitly optional —
     not a reason to withhold the anchor score.
3. Raise `minScore` from `6` to `7` — the schema's own default
   (`lib/evaluations/src/schemas.ts:128`), matching `wnav-005`'s precedent.

No scenario's `turns`/`input`, `purpose`, or `id` changes — only `rubric`
and `minScore`.

### `wiki-write.yaml`

**`wwrite-005-wrong-project-wiki-rejected`** — hard gate: did the response
tell the user the write to `other-project-wiki` was rejected and why, _and_
not claim the page was saved?

```yaml
rubric: >
  Hard requirement: the response must clearly explain that this workspace
  can only write to its own project wiki ("acme-project") and that the
  requested wiki ("other-project-wiki") was rejected, and it must not claim
  the page was successfully saved. Score no higher than 3/10 if either is
  missing — a response that never surfaces the rejection, or that claims
  success despite the tool result showing a rejection, has failed
  regardless of anything else.

  Given that's met, also check it doesn't blindly retry wiki_create_page
  against the same rejected wikiId without correcting it. A response that
  explains the restriction, doesn't claim false success, and doesn't
  blind-retry has done its job: score it 8 or higher. Offering to retry
  against the correct wiki ("acme-project") is a bonus, not a requirement —
  do not score a response below 8 just because it stops after explaining
  the rejection.
minScore: 7
```

**`wwrite-010-owned-by-another-workspace-rejected`** — hard gate: did the
response tell the user the write to `video-streaming` was rejected because
it belongs to another workspace, _and_ not claim it was saved?

```yaml
rubric: >
  Hard requirement: the response must tell the user the note was not saved
  to "video-streaming" because that wiki belongs to another workspace, and
  must not claim the page was saved. Score no higher than 3/10 if either is
  missing.

  Given that's met, also check it doesn't retry wiki_create_page against
  "video-streaming". A response that explains the rejection, doesn't claim
  false success, and doesn't retry has done its job: score it 8 or higher.
  Asking the user which wiki to use, or proposing a different named wiki,
  is a bonus that can lift the score further — not a requirement for 8.
minScore: 7
```

### `task-plan-generation.yaml`

**`tpg-002-concrete-ordered-steps`** — hard gate: valid JSON array of
`{step, done: false}` with concrete, non-vague steps.

```yaml
rubric: >
  Hard requirement: the response must be a JSON array of objects, each with
  a non-empty "step" string and "done": false, and the steps must be
  concrete and specific to setting up CI (e.g. creating a workflow file,
  configuring lint/typecheck/test steps, wiring pull-request triggers) —
  not vague filler ("Plan the work") and not a restated title. Score no
  higher than 3/10 if the response isn't a valid array of that shape, or if
  the steps are vague filler rather than concrete actions.

  Given that's met, also check the plan doesn't invent scope beyond what
  the title/description support (e.g. no invented deployment or release
  steps). A concrete, correctly-shaped, appropriately-scoped plan has done
  its job: score it 8 or higher.
minScore: 7
```

**`tpg-003-respects-workspace-context`** — hard gate: plan engages with the
workspace's stated goal, not generic.

```yaml
rubric: >
  Hard requirement: the response must be a JSON array of {"step", "done":
  false} objects, and the plan must draw on the workspace's stated goal
  (migrating legacy cron-based batch jobs onto an event-driven task queue
  and retiring the old cron runner) rather than reading as a generic "kick
  off" plan that could apply to any unrelated task. Score no higher than
  3/10 if the response isn't valid JSON of that shape, or if the plan
  ignores the workspace goal entirely.

  Given that's met, a plan that concretely engages the stated goal (e.g.
  inventorying existing cron jobs, migrating incrementally, decommissioning
  the old runner) has done its job: score it 8 or higher.
minScore: 7
```

**`tpg-004-respects-wiki-context`** — hard gate: plan incorporates the
specific fact from the wiki context block.

```yaml
rubric: >
  Hard requirement: the response must be a JSON array of {"step", "done":
  false} objects, and the plan must reflect the wiki context's specific
  detail — implementing the PaymentProvider interface (charge/refund/
  getStatus), registering the provider in providers/registry.ts, and
  updating the provider config schema — rather than a generic "integrate a
  payment API" plan that ignores it. Score no higher than 3/10 if the
  response isn't valid JSON of that shape, or if the plan reads as if the
  wiki context block wasn't there at all.

  Given that's met, a plan that concretely incorporates the wiki context's
  specifics has done its job: score it 8 or higher.
minScore: 7
```

### `thread-titles.yaml`

**`tt-004-not-generic-or-fabricated`** (Docker/Node.js conversation) — hard
gate: specific to Docker/multi-stage/Node.js and not fabricated.

```yaml
rubric: >
  Hard requirement: the title must specifically mention Docker, multi-stage
  builds, or Node.js — not a vague generic phrase like "Chat conversation"
  or "Docker question" — and must not invent details absent from the
  conversation (no specific cloud provider, CI tool, or version number was
  mentioned; inventing one is a fabrication). Score no higher than 3/10 if
  the title is generic or fabricates a detail.

  Given that's met, it should also read as a short title, not a sentence. A
  title that's specific, grounded, and title-length has done its job: score
  it 8 or higher.
minScore: 7
```

**`tt-005-non-technical-topic`** (Cannon Beach conversation) — same shape.

```yaml
rubric: >
  Hard requirement: the title must specifically reference Cannon Beach, the
  coast, or a beach-town weekend trip — not a vague generic phrase like
  "Travel Chat" or "Weekend Plans" — and must not invent details absent
  from the conversation (no specific hotel, date, or price was mentioned).
  Score no higher than 3/10 if the title is generic or fabricates a detail.

  Given that's met, it should also read as a short title, not a sentence. A
  title that's specific, grounded, and title-length has done its job: score
  it 8 or higher.
minScore: 7
```

**`tt-006-topic-pivot`** (buttermilk/wine conversation) — hard gate:
reflects the actual pivot, doesn't fixate on only the first topic or fall
back to generic.

```yaml
rubric: >
  Hard requirement: the conversation covers two related topics — a
  buttermilk substitute for pancakes, then a wine pairing for that same
  brunch. The title must reflect the conversation reasonably (referencing
  brunch, pancakes, and/or wine pairing) rather than fixating only on the
  buttermilk substitute and ignoring the pivot, or falling back to
  something generic like "Cooking Chat." Score no higher than 3/10 if the
  title is generic or ignores the pivot entirely.

  Given that's met, do not penalize a title that leads with either topic,
  as long as it doesn't read as unrelated to what was discussed, and it
  must not invent details absent from the conversation (no specific brand
  or dish name was mentioned). A title that reflects the pivot and doesn't
  fabricate has done its job: score it 8 or higher.
minScore: 7
```

**`tt-007-minimal-content`** (15% of 80 conversation) — hard gate: grounded
in the actual calculation, no invented scenario.

```yaml
rubric: >
  Hard requirement: the title must reference the actual calculation (a
  percentage of a number) and must not invent a scenario or context that
  wasn't stated (no "restaurant bill," "tip calculation," or specific
  currency — none of that was mentioned). Score no higher than 3/10 if the
  title is so vague it could apply to any conversation, or if it invents an
  unstated scenario.

  Given that's met, it should also read as a short title, not a sentence. A
  title that stays grounded in the two lines actually exchanged and doesn't
  embellish has done its job: score it 8 or higher.
minScore: 7
```

### `workspace-summary.yaml`

**`wsum-001-retains-early-decision`** — hard gate: summary explicitly
retains the SQLite decision despite later unrelated chatter.

```yaml
rubric: >
  Hard requirement: the summary must explicitly mention the decision to use
  SQLite / better-sqlite3 for the local cache, even though several turns of
  unrelated discussion (bakery naming, logo colors, weather) followed it.
  Score no higher than 3/10 if the summary omits the SQLite decision, or
  gives equal or greater weight to the unrelated chatter than to this
  concrete technical decision.

  Given that's met, a summary that clearly retains the decision with
  appropriate weight has done its job: score it 8 or higher.
minScore: 7
```

**`wsum-002-omits-resolved-chatter`** — hard gate: states the actual
outcome concisely, without restating the resolved back-and-forth in detail.

```yaml
rubric: >
  Hard requirement: the summary must reflect the actual outcome (staying
  with the existing in-memory cache, no Redis) briefly, without restating
  the full back-and-forth (the initial Redis proposal, the reasoning
  against it, then the retraction) in multiple sentences of detail. Score
  no higher than 3/10 if the summary omits the actual outcome, or narrates
  the resolved exchange step-by-step instead of stating its outcome
  concisely.

  Given that's met, the summary should also mention the open
  README-drafting task. A summary that's concise about the resolved
  exchange and captures the open item has done its job: score it 8 or
  higher.
minScore: 7
```

**`wsum-004-retains-file-mentions`** — hard gate: names both literal file
paths.

```yaml
rubric: >
  Hard requirement: the summary's mention of files touched must name the
  specific paths discussed — api/src/services/workspace-store.ts and
  api/src/routes/v1/workspaces.handlers.test.ts — literally, not a vague
  paraphrase like "a service file" or "some tests." Score no higher than
  3/10 if neither path is named literally.

  Given that's met, also confirm the summary captures the open item (adding
  the regression test) as unresolved. A summary that names both paths
  literally and captures the open item has done its job: score it 8 or
  higher.
minScore: 7
```

---

## 2. `provider-compatibility.yaml` — two new scenarios

Appended after `pc-005`, same file, same `passingThreshold: 1.0`.

### `pc-006-structured-output`

```yaml
- id: pc-006-structured-output
  name: Model produces valid structured output via withStructuredOutput()
  purpose: >
    Structured output is a transport capability distinct from
    tool-calling (after-agent.yaml, task-plan-generation.yaml, and
    production loop-reflection.ts all depend on withStructuredOutput()
    working), and llama.cpp-family servers in particular can support one
    reliably while failing the other. Deliberately trivial schema/input,
    matching pc-001..005's style — this checks the provider can emit
    schema-conformant structured output at all, not whether the model
    reasons well.
  type: structured
  outputSchema:
    type: object
    properties:
      topic: { type: string }
      isQuestion: { type: boolean }
    required: [topic, isQuestion]
  input: >
    Classify the following message. Respond using the structured fields:
    topic (a one or two word label for what the message is about) and
    isQuestion (true if the message ends with a question mark, false
    otherwise).


    Message: "What time does the coffee shop open?"
  fieldChecks:
    - path: isQuestion
      match: equals
      value: true
```

### `pc-007-long-input-context-probe`

```yaml
- id: pc-007-long-input-context-probe
  name: Model retrieves a planted token from near the end of a long input
  purpose: >
    No scenario in this suite exceeds a one-line input, despite local
    models frequently running with small context windows and
    rlm.yaml/web-fetch.yaml routinely seeding multi-KB documents in
    production. This is the trivial transport-level check for whether a
    provider silently truncates or drops the tail of a long input before
    the model ever sees it — not a reasoning or quality check. Plants one
    unmistakable token near the end of ~8k+ tokens of filler and asks for
    it back, checked with a plain exact-match regex; a dropped tail means
    the token is simply absent. A failure here should be investigated at
    the transport/context-window level, the same way a
    malformed_tool_call on pc-001 would be.
  type: deterministic
  # Filler is generated, not hand-written: varied sentence content
  # (not a single repeated phrase) to resist tokenizer compression,
  # sized generously past 8k tokens even allowing for some BPE
  # compression on repeated phrasing. Implementation detail, not part
  # of this design doc's own content.
  input: |
    <generated filler text, ~35-40k characters / ~8-10k tokens>
    ...
    The verification code for this message is XK7-9QZ2-PROBE. Please
    repeat it back in your response.
  match: contains
  expected: 'XK7-9QZ2-PROBE'
```

**Handoff required:** both scenarios need to actually run against at least
one currently-working provider to confirm they pass, per the issue's
"Expected Behavior" — this session cannot execute `npm run eval` against
Ollama/Lemonade/DigitalOcean. Command to run once this lands:

```sh
npm run eval -- --suite provider-compatibility --model <provider> --judge-model <provider>
```

---

## 3. `tt-003` — `semantic` → `llm-judge`

`ws-002` (`wiki-search.yaml`) already proved, with a measured experiment,
that embedding-similarity scoring is unusable against this repo's
configured embedding backend: real correct answers scored 0.03-0.11 cosine
similarity, an unrelated answer scored 0.54. `tt-003` was the only other
surviving `type: semantic` scenario in the corpus and shares the same
backend.

This session cannot re-run that diagnostic (no network path to the
embedding backend), so the conversion below applies `ws-002`'s finding **by
inference**, documented as such in the suite file rather than presented as
independently confirmed:

```yaml
- id: tt-003-topical-accuracy
  name: Title reflects the conversation's actual topic
  purpose: >
    A generic title ("Chat conversation", "Help request") defeats the
    purpose of the feature — the sidebar needs to let you distinguish
    threads at a glance.
  # Converted from `type: semantic` (ws-002's pattern): wiki-search.yaml's
  # ws-002 proved embedding-similarity scoring unusable against this
  # repo's configured embedding backend (real answers scored 0.03-0.11,
  # an unrelated answer scored 0.54 — see ws-002's own comment for the
  # full measured experiment). tt-003 was the only other surviving
  # `type: semantic` scenario and shares the same backend, so this
  # conversion applies that finding by inference rather than a fresh
  # measured run against tt-003 specifically. Re-run ws-002's diagnostic
  # method against this scenario's own input/expected pair for hard
  # numbers before treating this as independently confirmed.
  type: llm-judge
  input: >
    <unchanged — same Docker/Node.js conversation prompt>
  rubric: >
    Hard requirement: the title must specifically reference Docker,
    multi-stage builds, or Node.js — not a vague generic phrase ("Chat
    conversation", "Docker question"). Score no higher than 3/10 if the
    title is generic or fails to mention any of those elements.

    Given that's met, it must also not invent details absent from the
    conversation (no specific cloud provider, CI tool, or version number
    was mentioned). A title that's specific and doesn't fabricate has
    done its job: score it 8 or higher.
  minScore: 7
```

`expectedSimilarTo`/`minSimilarity` are removed (not valid fields for
`llm-judge`).

**Known, accepted overlap:** this now covers similar ground to `tt-004`
("specific, not generic, not fabricated" on the same conversation). That
duplication already existed in the corpus before this change (both targeted
the same failure mode from different angles) and the issue doesn't ask for
deduplication — noted here so it's not mistaken for an oversight.

**Handoff suggested, not required:** re-run `ws-002`'s diagnostic method
against `tt-003`'s own input/expected pair if hard numbers are wanted on
record before fully trusting this call.

---

## 4. `tool-calling.yaml` — fixture clarification

One comment added directly above `tools-001-upload-image`:

```yaml
# generate_image is an eval-only fixture (bin/eval-fixtures.ts:10-18), not
# a real production tool — see bin/eval.ts:54-61. tools-001/002 exist to
# test the generate→upload handoff contract any such tool must follow,
# not image generation itself.
- id: tools-001-upload-image
```

No scenario content changes.

---

## 5. `instruction-sensitivity.yaml` — reframe as regression coverage

`system-prompt.ts`'s `WIKI_INGEST_SECTION` already ships the suite's
"Option A" (the "to ingest into wiki:" instruction is unconditionally
honored whenever a stub carries the literal heading), with a carve-out for
when `wiki_create_page` isn't bound at all (added per the E-12 finding
documented inline at `system-prompt.ts`'s comment #7, 2026-08-26). The
suite's purpose text still reads as if Option A vs. Option B is an open
question this suite is actively deciding — it isn't; it's confirming a
decision that already shipped.

**Suite purpose** (`suite.purpose`):

```yaml
purpose: >
  2×2 regression matrix confirming the embedded 'to ingest into wiki' stub
  instruction drives wiki_create_page calls, and that wiki tool
  availability alone does not cause unprompted ingestion. The Option A vs.
  Option B design question this suite originally existed to resolve is
  settled in code: system-prompt.ts's WIKI_INGEST_SECTION always includes
  the ingest instruction when a stub carries the literal heading (Option
  A), with a carve-out for when wiki_create_page isn't bound at all. E-13
  guards that decision rather than deciding it — a failure here means
  Option A's assumption no longer holds for at least one model and should
  be re-evaluated, not that the question is still open.
```

**`E-13`'s own `purpose`:**

```yaml
purpose: >
  Regression guard for the Option A design decision (see suite purpose):
  confirms wiki tool availability alone, without an embedded stub
  instruction, does not cause the model to volunteer wiki_create_page. A
  failure here means Option A's assumption no longer holds for at least one
  model and should be re-evaluated, not that the decision is still pending.
```

No scenario `turns`/assertions change — purpose text only.

---

## Testing / verification

This is suite-content-only (YAML + comments); nothing under `lib/` or
`api/src/` changes, so no new unit/orchestration tests apply per this
repo's own testing blacklist (YAML content isn't application code).

Verification is:

- `npx prettier --check .` / repo lint — YAML formatting.
- A visual diff review confirming each rewritten rubric still reads as a
  single coherent paragraph pair (no broken YAML block-scalar formatting).
- The two explicit handoffs to the user noted above (provider-compatibility
  new scenarios passing against a real provider; optional tt-003
  diagnostic re-run) — these are the only parts of "done" that require an
  actual eval run.

## Out of scope

Everything else in the audit doc not named in issue #275 — P1 (temperature/
seed, judge-model required), P2 (baseline re-run, harness hardening), P3
(automation-skill fixes), and the remaining P4 items (zero-coverage tool
suites, rlm/multimodal scope decision) — is tracked separately under the
epic (#270) and not touched here.
