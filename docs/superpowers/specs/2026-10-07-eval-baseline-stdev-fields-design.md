# Eval baseline stdev/min/max fields — design

## Context

[tkottke90/amazing-hashbrown#272](https://github.com/tkottke90/amazing-hashbrown/issues/272)
asks to re-baseline every eval suite now that provider sampling is pinned
(#271, merged via PR #277). Before any re-baselining is meaningful, the
baseline schema itself needs to change: today `eval-baselines.yaml` and
`update-baseline.mjs` only ever record the **mean** of `passedScenarios`
across N frozen rounds (`score`) — there is no way to see, at a glance,
whether a baseline is tightly clustered (trustworthy signal) or still
scattered (a sign of a real, unresolved capability ceiling rather than
noise).

This spec covers **only** the schema and tooling change. It does not cover:

- Actually running the 27 suites × 4 provider/model slugs to produce fresh
  baseline numbers (that's execution, done after this lands, and can't be
  done from this environment — there's no `config/config.yaml` here, so
  no eval round can actually be run in this session).
- Redesigning `auto-update-baseline` to run many suites/slugs in one
  invocation (today's one-suite-at-a-time flow is unchanged).
- The issue's "flag any nonzero-stdev pair as a candidate capability
  ceiling, cross-referenced against `system-prompt.ts`" analysis step —
  that's a judgment call made once real post-fix numbers exist, not a
  mechanism to build now.

## Schema change

Each `eval-baselines.yaml` entry gains three fields, computed from the raw
`passedScenarios` counts of the N frozen rounds (same units `score`
already uses — a raw count, not a percentage):

```yaml
after-agent:
  ollama-gptoss20b:
    provider: local
    model: GPT-OSS-20B
    judgeModel: local
    score: 15.6 # mean, unchanged
    min: 15 # NEW — lowest round's passedScenarios
    max: 17 # NEW — highest round's passedScenarios
    stdev: 0.8 # NEW — population stdev (÷N, not ÷N-1)
    total: 18
    rounds: 5
    updatedAt: 2026-10-07T00:00:00.000Z
    branch: main
    commit: abc123...
```

- **Population stdev, not sample stdev.** The N frozen rounds are the
  complete measurement being recorded, not a sample estimating some
  larger population's variance — so divide by N, not N-1.
- **Not backfilled.** Existing entries that aren't re-run keep their
  current shape (no `min`/`max`/`stdev`) until the next time that
  specific `(suite, slug)` pair is baselined. This matches the file's
  existing "replace on write, no additive history" behavior — nothing
  needs to touch entries this change doesn't rewrite.
- `stdev: 0` is the literal signal the issue's 90% success criterion
  checks for (fully deterministic pass/fail counts across all 5 rounds
  for a given suite/slug).
- The header comment's schema block
  (`eval-baselines.yaml` lines ~15-43) gets three new field descriptions
  inserted immediately after the existing `score:` description, matching
  the file's current comment style and level of detail.

## `update-baseline.mjs` contract change

**Before:** the calling skill averages `passedScenarios` across rounds
itself and passes a single `--score <avg>` plus `--rounds <N>`.

**After:** the calling skill passes every round's raw score, and the
script does all the arithmetic:

```sh
node .agents/skills/auto-update-baseline/scripts/update-baseline.mjs \
  --suite <suite-id> \
  --slug <provider-model-slug> \
  --provider <provider-name> \
  --model <human-readable-model-name> \
  --judge-model <judge-provider-name> \
  --round-scores 15,16,15,17,15 \
  --total <total> \
  --branch "$(git rev-parse --abbrev-ref HEAD)" \
  --commit "$(git rev-parse HEAD)"
```

- `--score` is removed; `--round-scores` (comma-separated) replaces it as
  the required input.
- `--rounds` is removed as a separate flag. `rounds` in the written entry
  is derived as `round-scores.length` — passing it independently risked
  drift between what was claimed and what was actually measured, and it's
  now fully redundant.
- Internally the script computes, from the parsed list of round scores:
  - `score` = arithmetic mean (unrounded, same precision convention as
    today).
  - `min` = `Math.min(...scores)`.
  - `max` = `Math.max(...scores)`.
  - `stdev` = population standard deviation of `scores`.
- **Validation:** the script exits non-zero with a clear message if
  `--round-scores` is missing, parses to zero elements, or contains any
  non-finite value (empty string, non-numeric token, `NaN`/`Infinity`
  after parsing). This is a hard failure, not something to silently
  coerce or default away — a malformed round-scores list means the
  caller's measurement itself is broken.
- `--total` and all other existing flags/behavior (header-comment
  preservation, replace-on-write semantics for the `(suite, slug)` key,
  `old_score=`/`new_score=`/`file=` stdout contract) are unchanged. The
  `old_score=` line still reports the prior `score` only — it does not
  need to grow an `old_min=`/`old_max=`/`old_stdev=` equivalent, since
  nothing downstream currently consumes those.

## `SKILL.md` change

`.agents/skills/auto-update-baseline/SKILL.md` Steps 5–6 currently
instruct: "average `passedScenarios` yourself, pass `--score`". Replace
with: "collect each round's `passedScenarios` into a list in round order,
pass the whole list via `--round-scores`, let the script compute the
mean/min/max/stdev." Step 7's report-back line adds `min`, `max`, and
`stdev` alongside the existing old/new score reporting, so the user
reviewing `git diff eval-baselines.yaml` has the dispersion numbers
called out in the chat summary too, not just visible in the diff.

## Testing

Per `AGENTS.md`'s testing rules, `update-baseline.mjs` does real
processing (parsing, arithmetic, YAML mutation) and is not covered by the
"testing blacklist" — it needs developer tests. Add
`.agents/skills/auto-update-baseline/scripts/update-baseline.test.ts`
(Mocha + Chai, matching repo convention) covering:

- **[unit]** mean/min/max/stdev computed correctly for a known,
  hand-calculated set of round scores (e.g. `[15, 16, 15, 17, 15]` →
  `score: 15.6, min: 15, max: 17, stdev: 0.8`).
- **[unit]** a single-round input (`--round-scores 15`) yields `stdev: 0`
  and `min === max === score`.
- **[unit]** malformed `--round-scores` (empty string, non-numeric token,
  missing flag entirely) causes a non-zero exit with a descriptive error,
  not a silently-written entry.
- **[unit]** rewriting one `(suite, slug)` entry leaves every other
  suite/slug entry and the header comment byte-for-byte untouched
  (regression check on existing behavior, now exercised against the new
  field set).

## Out of scope / explicitly deferred

- Running the actual 27×4 re-baseline matrix (execution step, happens
  after this merges, on a machine that can reach the configured
  providers).
- Any CI integration of `eval-baselines.yaml` as an automated regression
  gate (`docs/Design/2026-10-06-eval-system-reliability-audit.md` §2.4
  notes nothing currently reads this file to gate anything — unchanged by
  this spec).
- Deciding whether 5 rounds is still the right default now that sampling
  is pinned — issue #272 asks for that decision to be documented in the
  skill _if_ round count changes, but that's a call made with real
  post-determinism-fix data in hand, not before it exists.
