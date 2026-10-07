---
name: auto-update-baseline
description: >
  Runs N frozen rounds (default 5) of one of this repo's eval suites
  (suites/*.yaml) against a chosen provider+model and judge-model, then
  writes/overwrites that suite's baseline entry in the git-tracked
  `eval-baselines.yaml` at the repo root — the durable record that
  answers "what's the baseline for this eval" and "is this run a real
  regression" without relying on anyone's memory of a past score. Reuses
  the auto-eval-loop skill's `run-eval-round.sh` to actually execute each
  round rather than re-running `npm run eval` by hand. Use this whenever
  someone asks to "update the baseline," "re-baseline wiki-navigation,"
  "set a new baseline for <suite>," "record this as the baseline," invokes
  `/auto-update-baseline`, or asks whether a suite's current score counts
  as a regression and there's no baseline on file yet to compare against.
  Does NOT run the autonomous fix loop (that's auto-eval-loop) and does
  NOT post anything to GitHub (that's auto-eval-pr-comment) — this skill
  only measures and records a baseline number, then stops; it never edits
  suite YAML, system-prompt code, or commits anything on its own.
---

# Auto-update baseline

Writes an honest, reproducible baseline score into `eval-baselines.yaml`
for one `(suite, provider+model)` pair, so later runs of that suite have
something real to compare against instead of "it feels about the same as
last time." A baseline here is the **average of `passedScenarios` across
several frozen rounds**, not a single run's score — these suites have
measured, documented sampling variance (see the wiki-navigation design
doc's flakiness notes), and a baseline written from one lucky or unlucky
run would misinform exactly the question it exists to answer.

This skill does not special-case environments that can't reach a model
provider. It assumes it can run evals, and uses one concrete signal to
decide whether that's actually true: **whether `config/config.yaml`
exists.**

## Step 0 — Fail fast if there's no provider configuration

```bash
test -f config/config.yaml && echo present || echo missing
```

If `config/config.yaml` is missing, **stop here** — do not try `npm run
eval` anyway, do not fall back to some other signal, do not ask the user
if they're sure. Tell them plainly:

> This environment has no `config/config.yaml`, so there's no LLM
> provider configured to run evals against. To set one up:
>
> ```sh
> cp api/config.yaml.example config/config.yaml
> ```
>
> then edit it to point at a real provider (Ollama, OpenAI, Anthropic,
> or an OpenAI-compatible endpoint like Lemonade) — see
> `docs/App-Docs/Providers.md` for the field reference and worked
> examples. Come back and run this again once that's in place.

Do not attempt any of the steps below without a real `config/config.yaml`
on disk.

## Step 1 — Determine the suite(s)

If the request already names one (e.g. "re-baseline wiki-navigation"), use
it. Otherwise ask, listing the options from `suites/*.yaml` (one suite id
per file, matching the file's basename). A single invocation can baseline
more than one suite — repeat Steps 3–6 per suite, but confirm the full set
up front rather than discovering a second suite mid-run.

## Step 2 — Determine the provider+model and judge-model combo(s)

Read `config/config.yaml` directly (it's a short, hand-maintained file —
just open it, no need to script a parse) and look at its `providers:`
list. Each entry has `name`, `type`, and (usually) `defaultModel`; show
those as the real options. **Never guess or invent a provider/model
name**; if the file's provider list doesn't obviously contain what the
user asked for by name, show them the list and ask them to pick.

Ask the user:

- Which provider+model to baseline (the `provider` field will be that
  entry's `name`; the `model` field should be the human-readable model
  name, e.g. "GLM-4.7-Flash" — ask if `defaultModel` in the config is a
  terse tag like `qwen3:14b` and a nicer display name is wanted instead).
- Which provider to use as the judge model (same list; in practice this
  repo has often used a provider named `local` as judge — a reasonable
  default to suggest, not something to assume silently).
- The **provider-model slug** this baseline will be keyed under in
  `eval-baselines.yaml` — short, kebab-case, e.g. `lemonade-glm` or
  `ollama-qwen3-14b`. There's no mechanical rule for shortening an
  arbitrary model id, so propose one (provider name + a short recognizable
  piece of the model name) and have the user confirm or correct it. If a
  baseline already exists in `eval-baselines.yaml` for this suite with a
  slug that's clearly the same provider+model, reuse that exact slug
  rather than creating a near-duplicate.

## Step 3 — Confirm the round count

Default to **5 frozen rounds** per suite/provider/model combo. This number
comes from issue #235's own validation-plan wording, not an arbitrary
choice — mention that to the user if they ask why 5. Ask if they want a
different N; a lower N for a quick sanity check is fine, but note in your
final report that the baseline was written from fewer rounds than the
default if so.

## Step 4 — Run the rounds

Reuse `auto-eval-loop`'s existing script directly — it already knows how
to run one eval round and print machine-readable results, so there's no
reason to re-implement "run `npm run eval` and parse the result" here:

```bash
.agents/skills/auto-eval-loop/scripts/run-eval-round.sh <suite> <provider> <judge-provider> <round-id>
```

Run the rounds **in series**, not in parallel (same reasoning as
auto-eval-loop: these hit local model servers that likely can't handle
concurrent load). Give each round a `<round-id>` that won't collide with
an unrelated auto-eval-loop session's log files, e.g.
`baseline-<suite>-<slug>-1`, `baseline-<suite>-<slug>-2`, … — the script
writes its combined log to
`eval-logs/run-logs/round-<round-id>-<provider>.log`, and a reused id
would silently overwrite another session's log.

Treat `exit_code` 2 or 3 (printed by the script) as the run itself
breaking (bad args, runtime error), not an eval failure to tolerate — read
the `console_log` path it prints, fix the underlying problem, and restart
the round count rather than averaging in a broken run.

## Step 5 — Read each round's result and collect round scores

For each round, read the YAML file at the `result_yaml=` path the script
printed. Pull two fields from its `run:` block:

- `run.passedScenarios` — the raw count of scenarios that passed. Append
  it, in round order, to a running list — this list becomes
  `--round-scores` in Step 6. Do **not** average these yourself; the
  script computes the mean, `min`, `max`, and `stdev` from the full list.
- `run.scoredScenarios`, **falling back to `run.totalScenarios`** if
  `scoredScenarios` is absent — this matches `getScoredScenarios()` in
  `lib/evaluations/src/runner.ts`, and exists because older result files
  predate the `scoredScenarios` field, and because the raw scenario count
  can include skipped/pending-human results that were never part of the
  denominator `passRate` was actually computed against.

After all N rounds:

- `round-scores` = the ordered list of each round's `passedScenarios`
  (e.g. `15,16,15,17,15`) — pass it to the script verbatim via
  `--round-scores`, comma-separated, in the order the rounds ran.
- `total` = the **last** round's `scoredScenarios` (with the
  `totalScenarios` fallback above). It should be constant across rounds
  for the same suite/model, but take the last one defensively rather than
  asserting they all match.

## Step 6 — Write the baseline entry

Get the current branch and commit:

```bash
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
```

Then write the entry with the helper script (it preserves
`eval-baselines.yaml`'s header comment and every other entry — don't hand-
edit the YAML to do this):

```bash
node .agents/skills/auto-update-baseline/scripts/update-baseline.mjs \
  --suite <suite-id> \
  --slug <provider-model-slug> \
  --provider <provider-name> \
  --model <human-readable-model-name> \
  --judge-model <judge-provider-name> \
  --round-scores <comma-separated passedScenarios, round order, e.g. 15,16,15,17,15> \
  --total <total> \
  --branch "$(git rev-parse --abbrev-ref HEAD)" \
  --commit "$(git rev-parse HEAD)"
```

It prints `old_score=` (the prior value for this exact `(suite, slug)`
key, or `none`), `new_score=`, and `file=`. **A baseline update replaces
the previous entry for that key — it is not additive history.** If you
need to compare against the old number, read it from the `old_score=`
line before the overwrite, not from `git log` after.

## Step 7 — Report back, don't commit

Tell the user plainly what changed: the suite, the slug, the old score
(or "no prior baseline" if `old_score=none`), the new score, `min`, `max`,
`stdev`, and `N` rounds — read `min`/`max`/`stdev` out of the entry the
script just wrote (its stdout only reports `old_score=`/`new_score=`/
`file=`), e.g. by opening `eval-baselines.yaml` and looking at the entry.
Point them at `git diff eval-baselines.yaml` to review the change
themselves.

**This skill never commits `eval-baselines.yaml` on its own.** Baseline
changes are a judgment call about whether a new number should become the
reference point — that's for the user (or a reviewer on a PR) to decide
by looking at the diff, not something to fold into an automatic commit.
