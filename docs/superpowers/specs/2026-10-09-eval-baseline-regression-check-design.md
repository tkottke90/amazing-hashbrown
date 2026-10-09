# Eval baseline regression checks — design

## Context

[tkottke90/amazing-hashbrown#273](https://github.com/tkottke90/amazing-hashbrown/issues/273)
(sub-issue of the eval-system-reliability epic, #270) observes that
`eval-baselines.yaml` exists specifically to answer "is this run a real
regression," but nothing in the codebase actually reads it to answer that
question:

- `lib/evaluations/src/comparator.ts`'s `compareRuns` compares two _run_
  objects passed in by id — never a baseline file.
- `bin/eval.ts` never loads `eval-baselines.yaml`.
- The file is referenced in exactly three non-generated files in the whole
  repo: the design doc that introduced it, the `/auto-update-baseline`
  skill, and its own update script.
- None of the three eval automation skills (`auto-eval-loop`,
  `auto-eval-pr-comment`, `auto-update-baseline`) ever reference the
  baseline when reporting a run's score.
- `npm run eval` is never invoked anywhere in `.github/workflows/*.yml`.

In practice, "is this a regression" is answered only by a human eyeballing
two numbers side by side. This spec adds an automated check, wires it into
the two reporting skills, and documents — rather than silently drops — the
CI-gating question the issue's dev notes raise.

This builds directly on #272 (merged: `eval-baselines.yaml` entries now
carry `min`/`max`/`stdev` alongside `score`, computed by
`update-baseline.mjs` from N frozen rounds — see
`docs/superpowers/specs/2026-10-07-eval-baseline-stdev-fields-design.md`).
Every current entry in `eval-baselines.yaml` already has these fields; the
re-baseline this depended on has already run.

## Scope decisions

- **One PR, full scope.** The CLI check and both skill integrations ship
  together — the issue's acceptance criteria and its single measurable
  success criterion only make sense as one unit; a capability nothing
  consumes yet is a half-finished state, not a stopping point.
- **No GitHub Actions job.** Per the issue's own dev note, cloud CI has no
  network path to the local Ollama/Lemonade providers these suites run
  against (the project's own eval docs already say so). This spec builds a
  locally-runnable, scriptable check only, and documents that gap
  explicitly in `docs/App-Docs/Evaluations.md` rather than leaving CI
  integration as an assumed-but-unbuilt future step.
- **Out of scope:**
  - Any change to `auto-eval-loop`'s stop/continue/diagnosis logic based on
    a regression verdict. This spec is reporting-only — the loop's existing
    pass/fail/continue decisions already come from the result YAML's
    `run.passed`, not from this check, and that stays true.
  - Fixing the `eval-logs/` git-add bug (audit trail never actually gets
    committed) — that's the epic's separate P3 item #12, not this issue.
  - Any SQLite schema change (see "Persistence" below).

## 1. `--check-baseline` flag on `bin/eval.ts`

A new boolean flag, plus an optional disambiguation flag:

```sh
npm run eval -- --suite after-agent --model ollama --judge-model anthropic --check-baseline
npm run eval -- --suite after-agent --model ollama --judge-model anthropic --check-baseline --baseline-slug ollama-gptoss20b
```

Behavior, after the suite run completes exactly as it does today (no
change to the existing run/report/exit-code-0/1/2/3 flow up to this
point):

1. Load `eval-baselines.yaml` from the repo root.
2. Look at `baselines[suiteId]` (the map of slug → entry for this suite).
3. **Resolve which entry to use:**
   - If `--baseline-slug` was given, use `baselines[suiteId][slug]`
     directly (error if that key doesn't exist).
   - Otherwise, auto-match: find every entry in `baselines[suiteId]` whose
     `provider` field equals the `--model` value (these are the same
     string — `resolveProviderConfig` matches `--model` against each
     provider's `name` in `config.yaml`, and that's exactly what
     `update-baseline.mjs` records as `provider`).
     - Exactly one match → use it.
     - Zero matches → "no baseline on file for suite `<id>`, provider
       `<model>`" error.
     - More than one match → error listing the candidate slugs and their
       `model` fields, asking for an explicit `--baseline-slug`.
4. **Staleness check:** if the matched entry's `total` doesn't equal this
   run's `scoredScenarios`, the baseline predates a scenario-count change
   in this suite and can't be meaningfully compared. Error: "baseline for
   `<suite>`/`<slug>` was recorded against `<total>` scenarios, this run
   scored `<scoredScenarios>` — re-run `/auto-update-baseline`." This is
   the same reasoning the stdev-fields design doc already gave for why
   `total` is pinned per baseline entry.
5. **Compute the verdict** (see §2) and print a block:

   ```
   [baseline] after-agent / ollama-gptoss20b
     Current:   18  (this run)
     Baseline:  13.2 ± 0.4  (mean ± stdev, n=5, min 13 / max 14)
     Verdict:   IMPROVEMENT
   ```

6. **Attach the result to the run** (see §3) so it's captured in the
   written result YAML, not just printed.

**Single-suite vs. batch mode:** when `--suite` is given, a missing or
ambiguous baseline is a hard error (exit `4` — see §4). When `--suite` is
omitted (the existing "run every suite" sweep), the check is lenient per
suite: a suite with no baseline entry for this provider is skipped
silently and the sweep continues, matching the issue's "every
suite/provider pairing that has a recorded baseline" framing — the
absence of a baseline for some suite in a 27-suite sweep isn't itself an
error condition, just nothing to report for that suite. A _stale_ or
_ambiguous_ baseline in batch mode is still a hard stop for that suite
(logged in the summary as an error row), since that's a real data problem
independent of whether a baseline happens to exist for every suite.

## 2. Verdict algorithm

New module `lib/evaluations/src/baseline.ts` (pure functions, no I/O
beyond the one `loadBaselineFile` entry point — matches the rest of
`lib/evaluations`'s pattern of keeping executors/comparators pure and
testable):

```ts
export type BaselineVerdict = 'WITHIN_BASELINE' | 'REGRESSION' | 'IMPROVEMENT';

export interface BaselineEntry {
  provider: string;
  model: string;
  judgeModel: string;
  score: number;
  min: number;
  max: number;
  stdev: number;
  total: number;
  rounds: number;
  updatedAt: string;
  branch: string;
  commit: string;
}

export function loadBaselineFile(filePath: string): Record<string, Record<string, BaselineEntry>>;

export function findBaselineEntry(
  file: Record<string, Record<string, BaselineEntry>>,
  suiteId: string,
  opts: { provider: string; slug?: string },
):
  | { slug: string; entry: BaselineEntry }
  | { error: 'not_found' | 'ambiguous'; candidates: string[] };

export function compareToBaseline(
  current: { score: number; total: number },
  entry: BaselineEntry,
):
  | { stale: true }
  | {
      stale: false;
      verdict: BaselineVerdict;
      delta: number;
      thresholdLow: number;
      thresholdHigh: number;
    };
```

- `thresholdLow = entry.score - entry.stdev`, `thresholdHigh = entry.score + entry.stdev`.
- `current.score < thresholdLow` → `REGRESSION`.
- `current.score > thresholdHigh` → `IMPROVEMENT`.
- Otherwise → `WITHIN_BASELINE`.
- `stdev: 0` collapses both thresholds to `entry.score` itself — any
  deviation is flagged. This is deliberate: the baseline file's own
  existing documentation says `stdev: 0` means the suite was fully
  deterministic across all 5 frozen rounds, so any drop there is a real
  signal, not noise.
- `current.total !== entry.total` → `{ stale: true }`; the caller (bin/eval.ts)
  turns this into the staleness error in §1 step 4, not a verdict.
- `delta = current.score - entry.score`.
- The caller (`bin/eval.ts`) always passes `current.score = run.passedScenarios`
  and `current.total = run.scoredScenarios` — the exact same raw-count
  fields `update-baseline.mjs` averages into `entry.score`/`entry.total`,
  so the comparison is apples-to-apples (never `passRate`, which is a
  derived percentage).

`BaselineEntry` is validated with a zod schema (`BaselineEntrySchema`) when
loaded — a malformed or hand-edited entry (missing `stdev`, non-numeric
field) fails loudly with a parse error naming the suite/slug, rather than
silently comparing against `undefined`.

## 3. Persistence: result YAML only, not SQLite

`EvalRunSchema` (`lib/evaluations/src/schemas.ts`) gains one new optional
field:

```ts
baseline: z.object({
  slug: z.string(),
  provider: z.string(),
  judgeModel: z.string(),
  baselineScore: z.number(),
  baselineStdev: z.number(),
  baselineMin: z.number(),
  baselineMax: z.number(),
  baselineTotal: z.number().int(),
  currentScore: z.number(),
  delta: z.number(),
  verdict: z.enum(['WITHIN_BASELINE', 'REGRESSION', 'IMPROVEMENT']),
}).optional(),
```

`writeResultYaml` already serializes the entire `run` object to YAML, so
this field rides along for free once `bin/eval.ts` sets `result.run.baseline`
before the file is written. **Checked against `store.ts`:** `eval_runs` is
an explicit-column SQLite table (`run_id`, `suite_id`, `passed`,
`passed_scenarios`, …), not a JSON blob — persisting this there would need
a real schema migration plus changes to `saveRun`/`findRunById`. That's a
disproportionate surface for what this feature needs. `store.saveRun`
already only reads the specific columns it inserts, so it's unaffected by
the new field and SQLite rows simply don't carry baseline info. `eval:compare`
and `eval:review` (which read from the store) are untouched — this
remains a YAML-file-only addition, deliberately.

Because `runEval()` writes the YAML internally before returning, and the
baseline comparison needs that same run's `passedScenarios`/`scoredScenarios`
_after_ the run completes, `bin/eval.ts` computes the comparison from
`result.run` post-hoc and re-invokes `writeResultYaml(mutatedRun, result.results, resultPath)`
— the filename is deterministic from `run.suiteId` + `run.startedAt`, so
this overwrites the same file in place with the `baseline` field added,
rather than requiring any change to `runner.ts` or `serializer.ts`'s
existing write path.

## 4. Exit codes

Extends the table in `docs/App-Docs/Evaluations.md`. Existing codes
(`0`/`1`/`2`/`3`) are unchanged in meaning; two new codes apply only when
`--check-baseline` is passed:

| Code | Meaning                                                                                                                                                                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4`  | `--check-baseline` was passed but no baseline entry could be used — not found, ambiguous (multiple slugs match the provider), or stale (scenario-count mismatch). Never conflated with a pass.                                                                                                          |
| `5`  | `--check-baseline` was passed and the verdict is `REGRESSION`. Independent of the suite's own pass/fail against its `passingThreshold` — a suite can still exit `5` even if it otherwise passed its own scenarios, because "worse than history" and "failed its own threshold" are different questions. |

`WITHIN_BASELINE` and `IMPROVEMENT` verdicts don't change the exit code —
the run's own normal `0`/`1` (threshold pass/fail) stands.

## 5. `auto-eval-loop` integration

- `.agents/skills/auto-eval-loop/scripts/run-eval-round.sh`: the `CMD`
  array unconditionally adds `--check-baseline`. Its header comment's
  exit-code line is updated to document `4`/`5`. No behavior change to
  what the script extracts (`result_yaml`/`report_html`/`exit_code`) —
  the baseline verdict lives in the result YAML the agent already reads.
- **No change to loop control.** `SKILL.md`'s "Field notes" already say
  `result: pass`/`fail` is taken directly from `run.passed` in the result
  YAML, not from the shell exit code — so this script change doesn't touch
  how the loop decides to keep iterating or stop. A `5` (regression) exit
  is informational, read by the agent off the YAML's new `run.baseline`
  field when narrating the round, exactly like `score`/`total` are today.
- The audit-log schema (`eval-logs/auto-eval-<timestamp>.yaml`) gains an
  optional `baseline:` sub-object per model entry under `runs[].models[]`,
  mirroring the YAML field:

  ```yaml
  runs:
    - id: 3
      models:
        - name: ollama
          judge: anthropic
          score: 18
          total: 18
          result: pass
          details: eval-results/after-agent-...yaml
          baseline:
            slug: ollama-gptoss20b
            baselineScore: 13.2
            baselineStdev: 0.4
            verdict: IMPROVEMENT
            delta: 4.8
  ```

  Documented in `SKILL.md`'s existing "Field notes" section alongside
  `score`/`total`/`result`. Omitted entirely for a model with no baseline
  on file (not written as `null` or empty) — matching the "every pairing
  that has a recorded baseline" framing.

## 6. `auto-eval-pr-comment` integration

`.agents/skills/auto-eval-pr-comment/references/comment-format.md`'s
"Score trajectory" section (item 5) gets a rule: when the audit log's
final round for a model/suite pairing carries a `baseline` field, append
it to that score, in both the compact-table and per-round-narrative
shapes:

```
| Model    | Initial | Converged | Baseline |
| -------- | ------- | --------- | -------- |
| `ollama` | 13/18   | 18/18     | 13.2 ± 0.4 → **IMPROVEMENT** (+4.8) |
```

or, in narrative form: "`ollama` converged at 18/18 — baseline is
13.2 ± 0.4 (`ollama-gptoss20b`), so this is an **IMPROVEMENT** (+4.8)."

For a pairing with no `baseline` field anywhere in the log, the column/
clause is omitted entirely — never fabricated, never shown as "N/A" (which
would read as "checked, found nothing" rather than "not checked"). Style
notes section gets one line: bold the verdict word itself, matching how
scenario IDs and SHAs are already backticked.

## 7. Documentation (`docs/App-Docs/Evaluations.md`)

- New subsection after "Exit codes" (or near it): "Baseline regression
  checks" — explains `eval-baselines.yaml`, `--check-baseline`, the
  1-stdev verdict rule, and the exit `4`/`5` codes. Today this file never
  mentions baselines at all (confirmed gap from the audit).
- One explicit paragraph stating that full CI gating (a GitHub Actions job
  running this on every PR) isn't implemented because cloud CI runners
  have no network path to the local Ollama/Lemonade providers these
  suites target, and that `--check-baseline` is designed to be run locally
  (by a person, or by `auto-eval-loop`) instead. This directly answers the
  issue's own dev note rather than leaving the omission unexplained.
- Exit codes table gets the two new rows from §4.

## Testing

Per `AGENTS.md`'s testing policy, `lib/evaluations/src/baseline.ts` does
real processing (YAML parsing, matching, threshold arithmetic) and needs
developer tests (Mocha + Chai, adjacent `baseline.test.ts`):

- **[unit]** `compareToBaseline` returns `WITHIN_BASELINE` when current
  score is within `score ± stdev`.
- **[unit]** `compareToBaseline` returns `REGRESSION` when current score
  is below `score - stdev`, including the `stdev: 0` case where any drop
  below `score` regresses.
- **[unit]** `compareToBaseline` returns `IMPROVEMENT` symmetric to the
  above.
- **[unit]** `compareToBaseline` returns `{ stale: true }` when
  `current.total !== entry.total`, regardless of score.
- **[unit]** `findBaselineEntry` auto-matches the single entry whose
  `provider` equals the given provider.
- **[unit]** `findBaselineEntry` returns `{ error: 'not_found' }` when no
  entry matches, and `{ error: 'ambiguous', candidates }` when more than
  one does.
- **[unit]** `loadBaselineFile` throws a descriptive error for a baseline
  entry missing a required field (e.g. no `stdev`).
- **[orchestration]** `bin/eval.ts`'s `--check-baseline` flow: a
  `supertest`-free direct invocation isn't practical for a CLI script, so
  this is covered by exercising the exported pieces (`findBaselineEntry` +
  `compareToBaseline` composed together against a fixture
  `eval-baselines.yaml`-shaped object) rather than spawning the actual
  script — consistent with how `bin/eval.ts` itself has no direct test
  file today (it's a thin CLI wrapper per the testing blacklist's "pure
  wiring" carve-out; the logic it wires together is what's tested).

Per the issue's own measurable success criterion, manual verification
after implementation: run `--check-baseline` against 3 suites with
intentionally-reverted code and confirm `REGRESSION` + exit `5` in all 3;
run it against the same 3 suites with no code changes and confirm
`WITHIN_BASELINE` + exit `0`/`1` (per the suite's own threshold) in all 3.
This requires a reachable local provider and is called out in the
implementation plan as a step the user runs and confirms, not something
this session can execute itself (no `config/config.yaml` / reachable
provider from this environment).
