---
name: auto-eval-loop
description: >
  Runs this repo's autonomous eval-and-fix loop for the LLM agent behavior
  suites under suites/*.yaml: execute `npm run eval` against one or more
  configured local model providers (e.g. ornith, glm), read the structured
  YAML results, diagnose real failures versus scenario-assertion issues
  versus model capability limits, edit the code (usually
  api/src/agents/system-prompt.ts or a suites/*.yaml scenario), commit, and
  repeat until the suite passes or the loop hits a real limit. Keeps a
  running eval-logs/auto-eval-<timestamp>.yaml audit trail of every round:
  each model's score, pass/fail, and exactly what changed and why. Use this
  whenever someone asks to "run the eval loop," "iterate on the system
  prompt until the eval passes," "auto-fix the wiki-navigation eval," "keep
  tuning until ornith and glm both pass," "close out the remaining eval
  failures," or wants a hands-off, self-documenting pass at eval failures
  rather than reviewing one run at a time by hand. Also use it if someone
  just says "run the evals and fix what's broken" without naming this skill
  explicitly — that request is exactly this workflow.
---

# Auto-eval loop

This automates a workflow that, up to now, has been done by hand: run an eval
suite against one or more local models, read the raw results, figure out
whether each failure is a real prompt gap, a too-strict scenario assertion,
or a model that's simply hit a capability ceiling, make a targeted fix, and
rerun. The judgment calls in that loop are exactly what makes it worth having
an agent do — not a fixed script — but the mechanics (running the command,
tracking scores across rounds, writing an audit trail) are exactly the kind
of bookkeeping worth automating so it doesn't eat your attention every round.

**Read `references/interpreting-results.md` before diagnosing any failure or
writing any fix.** It captures specific, hard-won lessons (what `calledTools`
actually tells you, when a failure is a scenario bug instead of a model bug,
why contrastive examples work better than abstract rules, how to recognize a
model that's simply maxed out) from doing this exact loop manually. Skipping
it risks repeating mistakes that already happened once.

## Setup — do this once per invocation, not once per round

**1. Find or create the log file.** Check whether this conversation already
has an `eval-logs/auto-eval-*.yaml` in play (the user referenced one, or you
created one earlier in this session). If so, keep using it — append rounds
to the same file rather than starting over. Otherwise, check `eval-logs/`
for existing files and ask the user whether to continue one of those or
start fresh. Only create a new file if the user confirms a fresh start:

```bash
mkdir -p eval-logs
FILENAME="eval-logs/auto-eval-$(date +%Y%m%d%H%M%S).yaml"
```

**2. Determine the suite.** If the request already names one (e.g. "run the
loop on wiki-search"), use it. Otherwise ask, defaulting the suggestion to
`wiki-navigation` — list the other options from `suites/*.yaml` if the user
wants to see them.

**3. Determine the model(s) to evaluate.** Read `config/config.yaml`'s
`providers:` list (each entry has a `name`) to see what's actually
available. If that file doesn't exist yet, tell the user to copy
`api/config.yaml.example` to `config/config.yaml` and configure at least one
provider before continuing — don't guess model names. If the request doesn't
already specify which provider(s) to evaluate, ask, showing the configured
names as options. Multiple models can be evaluated per round.

**4. Determine the judge model.** Same process — ask if not specified. In
practice this repo has consistently used a provider named `local` as the
judge for `llm-judge`-type scenarios; that's a reasonable default to suggest,
not something to assume silently.

**5. Confirm the stopping rules.** Default to a 5-round cap and plateau
detection (see "Stopping" below) unless the user asks for something else.
Also confirm: commit after each round (the default — see "Committing"
below), or leave changes uncommitted for manual review.

## The log file

Each round appends one entry to `runs:` and one matching entry to `log:`
(same `id`). Structure:

```yaml
createdAt: 2026-07-26T14:00:00Z
suiteId: wiki-navigation
nextRunId: 3
runs:
  - id: 1
    startedAt: 2026-07-26T14:00:05Z
    models:
      - name: ornith
        judge: local
        score: 9
        total: 12
        result: fail
        details: eval-results/wiki-navigation-2026-07-26T14-00-10-000Z.yaml
        debug: eval-logs/run-logs/round-1-ornith.log # only present if debug logging was used
      - name: glm
        judge: local
        score: 11
        total: 12
        result: pass
        details: eval-results/wiki-navigation-2026-07-26T14-01-20-000Z.yaml
  - id: 2
    startedAt: 2026-07-26T14:10:00Z
    models:
      - name: ornith
        judge: local
        score: 11
        total: 12
        result: pass
        details: eval-results/wiki-navigation-2026-07-26T14-10-05-000Z.yaml
log:
  - id: 1
    debugHttp: false
    summary: |
      Ran wiki-navigation against ornith (9/12, fail) and glm (11/12,
      pass). ornith failed wnav-004, wnav-009, wnav-010b, wnav-010c — all
      four came back with calledTools showing a real tool was invoked, not
      an empty response, so this isn't a serving-side issue. wnav-009 in
      particular shows the model treating a two-candidate wiki_locate
      result as if it had only one candidate.
    modifications:
      - api/src/agents/system-prompt.ts: |
          Added a concrete, countable test to WIKI_NAVIGATION_SECTION: did
          wiki_locate's result name more than one domain at all, regardless
          of whether the model then resolved it to one. Targets wnav-009's
          failure mode specifically.
      - api/src/agents/system-prompt.test.ts: |
          Added a regression test asserting the new sentence is present.
    commit: a1b2c3d
  - id: 2
    debugHttp: false
    summary: |
      Reran after the wnav-009 fix. ornith now passes at 11/12 (was 9/12),
      clearing wnav-009 and wnav-004; wnav-010b and wnav-010c also
      recovered as a side effect of the same wording change. glm remained
      at 11/12, unaffected either way. Both models now pass the suite's
      0.85 threshold — stopping here.
    modifications: []
    commit: e4f5a6b
```

This is a worked example to show the shape, not a template to copy verbatim
— use the real scenario IDs, numbers, and reasoning from the actual run in
front of you.

Field notes:

- `score` / `total`: `score` is the raw count of passed scenarios (not a
  percentage), `total` is the suite's scenario count — both come straight
  from the result YAML's `run.passedScenarios` / `run.totalScenarios`. `total`
  isn't in the original spec this skill was built from, but without it a
  bare `score: 9` is meaningless once suites have different scenario counts
  — keep it.
- `result`: `pass` or `fail`, taken directly from the result YAML's
  `run.passed` (which already accounts for the suite's own
  `passingThreshold` — don't recompute this from `score`/`total` yourself).
- `debug`: only present on a model entry if that model's round used
  `DEBUG_LLM_HTTP=1` (see `references/interpreting-results.md` §6 for when
  that's actually warranted). Omit the key entirely otherwise, don't set it
  to null or empty string.
- `log[].debugHttp`: whether _any_ model this round used debug logging — a
  quick per-round summary, detail lives in the per-model `debug` field.
- `log[].summary`: wrap prose to a human-readable width (aim for ~70-80
  columns) using YAML's `|` block literal, the way the example above does —
  don't emit one giant unwrapped line. Be concrete: name scenario IDs,
  compare to the previous round's numbers, and say what you concluded about
  _why_ something failed, not just that it did.
- `log[].modifications`: one entry per file touched, keyed by a short
  relative path, value is a short prose description of the change and its
  motivation. If a round made no code changes (e.g. it was purely a rerun
  to confirm the previous fix, or everything already passed), use `[]`.
- `log[].commit`: the commit SHA for that round's changes, filled in after
  committing (see "Committing"). Omit if the user opted out of auto-commit.

## The loop

Each round:

**1. Decide whether debug logging is warranted** for each model this round
— default no; see `references/interpreting-results.md` §6 for the specific
signature that justifies it (empty `calledTools`, empty output, and
`finish_reason: "tool_calls"` all at once, in a _previous_ round's result you
can't otherwise explain).

**2. Run the suite for each configured model, in series** (not parallel —
these hit local model servers that likely can't handle concurrent load).
Use the bundled helper rather than hand-parsing terminal output:

```bash
.claude/skills/auto-eval-loop/scripts/run-eval-round.sh <suite> <model> <judge> <round-id> [--debug]
```

It prints `result_yaml=`, `report_html=`, `exit_code=`, `console_log=`, and
(if `--debug` was passed) `debug_log=` — one per line, nothing else on
stdout. Treat `exit_code` 2 or 3 as the run itself breaking (bad args,
runtime error) rather than an eval failure to diagnose; read `console_log`
to see what went wrong and fix that before continuing the loop.

**3. Read each result YAML in full** — every scenario's `passed`,
`toolCalled`, `calledTools`, `reasoningContent`, and `actualOutput`, not just
the top-level pass rate. This is where `references/interpreting-results.md`
matters most.

**4. Append this round's entry to `runs:` and `log:`** in the auto-eval YAML
(see schema above), and increment `nextRunId`.

**5. Check whether every model's `result` is `pass`.** If so, you're done —
tell the user, make sure the log file reflects it, and stop. Don't make
further code changes once everything passes just because you can.

**6. Otherwise, diagnose each failure** using
`references/interpreting-results.md`'s framework: real prompt/model gap,
too-strict scenario assertion, or capability ceiling. Different failures in
the same round can land in different buckets — handle each on its own
merits rather than picking one theory for the whole round.

**7. Apply the plateau check** (see "Stopping" below) before writing new
code. If every remaining failure is ceiling-flagged, stop the whole loop
here rather than making a change you don't expect to help.

**8. Make the fix(es)** for anything that isn't ceiling-flagged — extend an
existing contrastive example before adding a new abstract rule, loosen a
scenario assertion if that's what's actually wrong, and follow this repo's
existing documentation convention (the running header comments above each
`system-prompt.ts` section, and matching entries in
`system-prompt.test.ts`). Record exactly what you changed and why in this
round's `log[].modifications`.

**9. Commit** (see "Committing"), record the SHA in `log[].commit`, then
loop back to step 1 for the next round — subject to the cap.

## Stopping

**Iteration cap.** Default 5 rounds; ask the user if they want a different
number. When the cap is hit without every model passing, stop, write a
final log entry summarizing the state honestly (which scenarios are still
failing and your best read on why), and tell the user directly rather than
silently giving up mid-loop.

**Plateau detection.** Before starting a new round's fix, check: did the
_same_ scenario fail, in the _same_ shape (same wrong tool via
`calledTools`, or the same kind of reasoning gap), in the round immediately
after a fix specifically targeted that scenario? If so, per
`references/interpreting-results.md` §5, this is very likely a model
capability limit, not a wording gap — flag it explicitly in that round's log
entry, stop making further changes aimed at that specific scenario, and:

- if other, non-ceiling-flagged failures remain, keep looping on those;
- if every remaining failure is ceiling-flagged, stop the whole loop and
  say so plainly — don't keep spending rounds on something the log itself
  shows isn't responding to wording changes.

## Committing

Default (confirmed with the user at setup): commit once per round, covering
the code changes made that round plus the updated auto-eval log file
itself. Stage only what that round actually touched — don't blanket
`git add -A`. Write the commit message from that round's summary, e.g.:

```
git add api/src/agents/system-prompt.ts api/src/agents/system-prompt.test.ts eval-logs/auto-eval-<timestamp>.yaml
git commit -m "auto-eval round 3: narrow wnav-010 example to cover possessive phrasing"
```

If the user opted out of auto-commit during setup, skip this step entirely
and leave the round's changes as uncommitted working-tree edits instead —
still update `log[].modifications`, just omit `log[].commit`.

Never force-push, amend, or touch branches other than the current one. If a
commit fails (e.g. a pre-commit hook), fix the underlying issue and commit
again — don't skip hooks to push past it.
