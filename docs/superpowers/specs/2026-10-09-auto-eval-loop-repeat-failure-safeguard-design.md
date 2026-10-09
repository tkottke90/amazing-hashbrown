# Auto-Eval-Loop Repeat-Failure Safeguard — Design

**Date:** 2026-10-09
**Issue:** [#274](https://github.com/tkottke90/amazing-hashbrown/issues/274) — Chore: Add repeat-failure safeguard to auto-eval-loop
**Source:** `docs/Design/2026-10-06-eval-system-reliability-audit.md`, §3.1, §3.5, §6 (P3)

## Summary

Two independent fixes to the `auto-eval-loop` skill (`.agents/skills/auto-eval-loop/`), plus a doc-wording fix to its sibling `auto-eval-pr-comment`. No harness code (`bin/eval.ts`, `lib/evaluations/`) changes — this is scoped entirely to the skill layer.

1. **Repeat-failure safeguard**: before the loop diagnoses, edits code for, or commits against any scenario that failed in a round, it must confirm the failure isn't sampling noise by rerunning the suite 3 times under identical conditions (reusing the existing `npm run eval:probe` determinism tool) and requiring ≥2/3 failures before treating it as real.
2. **Commit-step bug fix**: stop instructing `git add` on the gitignored `eval-logs/` path (it fails every round today, so the audit trail is never actually committed as documented). The fix is not to un-ignore the path — it's to drop the premise that the audit YAML needs to be committed at all, and reword both skills so the GitHub PR comment (`auto-eval-pr-comment`) is named as the durable, reviewable record instead.

`nextRunId`'s hand-incremented desync risk (mentioned in the issue's Dev Notes) is explicitly **out of scope** — it's not in the issue's Expected Behavior, and is left for a separate pass.

### Deviation from the issue as filed

The issue's literal acceptance criterion — "running `auto-eval-loop` end to end... produces a commit whose `git show --stat` output lists the `eval-logs/auto-eval-<timestamp>.yaml` path" — is **not** what this design implements. During brainstorming, weighing the clutter of permanently accumulating timestamped session logs in `main` (trunk flow merges every branch's commits straight in, nothing prunes them) against the actual value of committing (mainly: letting a _different_ session resume the same audit trail), the decision was to keep `eval-logs/` fully gitignored and lean on the PR comment as the durable record instead. See "Commit-step fix" below for the replacement criterion.

### Future consideration (not in scope)

The real fix for "this repo has no durable, queryable home for eval run history" is an external storage solution for eval audit trails — the eval equivalent of how SonarQube stores analysis results outside the repo it analyzes — not committing YAML files into `main` and not accepting that the record only survives within one session/checkout. This design accepts the session-locality limitation as a pragmatic stopgap and documents it honestly; building real external storage is future work, tracked separately (not as part of this issue).

### Addendum, 2026-10-09: repeat-check must fire regardless of overall round result

The implementation of this design initially gated the repeat-check behind "does every model's round clear the suite's passing threshold overall" — a model whose round already `pass`ed (even with one failed scenario) skipped the probe entirely. A live run against `wiki-navigation`/Ornith (14/15, clears the 0.85 threshold) exposed this immediately: the one miss, `wnav-004`, got dismissed as "an already-confirmed ceiling" from the agent's own memory, without the repeat-check ever running. Since the repo's own suites commonly use a threshold that tolerates one flaky miss, this meant the safeguard could never fire for exactly the scenarios it was built for.

**Corrected behavior (confirmed with the user):** the repeat-check runs for every scenario that failed this round, for every model, regardless of whether that model's own round already clears the suite's threshold. A scenario confirmed `real` inside an otherwise-passing round still gets diagnosed and fixed — probing it and then refusing to act on a confirmed-real result would defeat the point of confirming it. This also means an overall-passing round with one persistently flaky scenario pays the 3x rerun cost every round until that scenario stops failing even once in a probe, not only on rounds where the suite outright fails. `auto-eval-loop/SKILL.md`'s steps 5/5a/5b were reordered accordingly (the repeat-check and its classification now happen before any "are we done" decision, not after one that could short-circuit around it).

---

## 1. Repeat-failure safeguard mechanics

### Where it plugs into the loop

Insert between the existing step 5 ("read each result YAML") and step 6 ("diagnose each failure") of `SKILL.md`'s per-round loop:

- **5a.** For each model with ≥1 failed scenario this round, run the repeat-check (see script below) for exactly those failed scenario IDs. Models that passed outright this round are skipped — no probe needed.
- **5b.** Classify each probed scenario as `real`, `noise`, or `inconclusive` (see verdict rule below).
- **5c (revised step 6 gate).** Only `real` (and `inconclusive`, fail-safe) scenarios proceed to diagnosis/edit. `noise` scenarios are logged and otherwise ignored this round.
- **5d (revised step 5's stopping check).** A model's round counts as effectively passing — for the purposes of "is everyone done, stop the loop" — if its raw result was `pass`, **or** every one of its failed scenarios classified as `noise`.

### Verdict rule

Given a scenario's 3 outcomes (`pass`/`fail`/`error`/`missing` from `eval:probe`'s own vocabulary):

- Any `error` or `missing` outcome → **`inconclusive`**. Treated as `real` for step 6 purposes (never let a broken safeguard silently suppress a real bug), but recorded distinctly so a reviewer can see the safeguard didn't cleanly run.
- Otherwise, `fail` count ≥ 2 → **`real`**.
- Otherwise (`fail` count ≤ 1) → **`noise`**. No diagnosis, no edit, no commit for this scenario this round.

If the whole `eval:probe` entry for a suite/model errored (exit 2/3 — a harness/usage problem, not a scoring disagreement), every scenario requested from it is `inconclusive`.

### Cost

Every round with ≥1 failure costs 3x that suite's runtime for the affected model(s), on top of the round's own run — `eval:probe` has no scenario-level filter, so confirming one failing scenario means rerunning the whole suite. This is accepted as the price of the safeguard (explicitly decided during brainstorming, keeping this issue from growing into a harness change); it matches how `eval:probe` already works elsewhere in this repo.

### New scripts

**`.agents/skills/auto-eval-loop/scripts/classify-repeat-check.mjs`** — pure Node, no process spawning, same shape as the existing `auto-update-baseline/scripts/update-baseline.mjs` (exported functions + a thin CLI wrapper, unit-testable against fixture JSON). Never hands the calling agent raw `probe.json` to parse itself — the whole point is a deterministic, testable classification, not an LLM guessing at JSON structure.

```
node classify-repeat-check.mjs \
  --probe-json <path to probe.json> \
  --suite <suite-id> \
  --model <model-name> \
  --scenario-ids <comma-separated scenario IDs>
```

Prints one line per requested scenario ID, plus a trailing `probe_json=` line, nothing else on stdout:

```
scenario_id=wnav-009 outcomes=fail,pass,fail fail_count=2 verdict=real
scenario_id=wnav-004 outcomes=fail,pass,pass fail_count=1 verdict=noise
probe_status=analyzed
probe_json=eval-logs/probe-2026-10-09T14-20-00-000Z/probe.json
```

Or, if the probe entry for that suite/model errored:

```
probe_status=errored
probe_reason=<the ProbeEntry's reason string>
scenario_id=wnav-009 verdict=inconclusive
scenario_id=wnav-004 verdict=inconclusive
probe_json=eval-logs/probe-2026-10-09T14-20-00-000Z/probe.json
```

Exported functions (for the adjacent unit tests): a function that classifies one scenario's outcomes array into a verdict, and a function that locates the right `ProbeEntry` in a loaded `probe.json` by `(suiteId, model)` and throws a descriptive error if a requested scenario ID isn't among its scored scenarios.

**`.agents/skills/auto-eval-loop/scripts/run-repeat-check.sh`** — thin bash wrapper, same contract style as the existing `run-eval-round.sh`: runs `npm run eval:probe -- --suite <s> --model <m> --judge-model <j> --runs 3 --ci --no-html [--seed N]`, tees output to `eval-logs/run-logs/`, greps the printed `Logs and probe.json: <dir>` line, then invokes `classify-repeat-check.mjs` itself and relays its output. One call for the agent:

```bash
.agents/skills/auto-eval-loop/scripts/run-repeat-check.sh <suite> <model> <judge> <round-id> <scenario-id-1>,<scenario-id-2>,...
```

No adjacent unit test for this script, matching `run-eval-round.sh`'s existing precedent — it's pure orchestration; the real logic lives in the `.mjs` it calls.

### New skill-dir scaffolding

`auto-eval-loop/` doesn't currently have a `package.json`/`.mocharc.json`/`test/` directory (unlike `auto-update-baseline/`, which does). This design adds that scaffolding, mirroring `auto-update-baseline/`'s exactly, so `classify-repeat-check.mjs` can have adjacent Mocha+Chai unit tests per this repo's AGENTS.md testing policy ("does this file do any processing?" — yes).

---

## 2. Log schema changes

`log[]` entries in the `eval-logs/auto-eval-*.yaml` audit trail gain a new, optional `repeatChecks` field:

```yaml
log:
  - id: 3
    repeatChecks:
      - scenarioId: wnav-009
        model: ornith
        outcomes: [fail, pass, fail]
        verdict: real
        probeLog: eval-logs/probe-2026-10-09T14-20-00-000Z/probe.json
      - scenarioId: wnav-004
        model: ornith
        outcomes: [fail, pass, pass]
        verdict: noise
        probeLog: eval-logs/probe-2026-10-09T14-20-00-000Z/probe.json
    summary: |
      ornith failed wnav-009 and wnav-004 this round. repeat-check:
      wnav-009 2/3 failed — treating as real; wnav-004 1/3 failed —
      treating as noise, no action taken. Diagnosed wnav-009 as...
    modifications:
      api/src/agents/system-prompt.ts: |
        ...
    commit: a1b2c3d
```

Field notes:

- `repeatChecks`: omit the key entirely for a round where nothing failed (no probing needed). Reserve `[]` for "probed but the list came back empty" (shouldn't normally happen).
- `repeatChecks[].verdict`: `real` | `noise` | `inconclusive`.
- `log[].summary` must still name the repeat-check verdict per scenario in prose (the issue's explicit requirement — e.g. "repeat-check: 2/3 failed — treating as real") even though the same information is in `repeatChecks` structured data. The structured list is for a script/future tooling to consume reliably; the prose sentence is for a human reviewer reading the log without cross-referencing.
- `modifications` only gets entries for scenarios diagnosed as `real` (or `inconclusive`) this round — a `noise` verdict never produces a code/suite edit.

---

## 3. Commit-step fix & doc rewording

### `auto-eval-loop/SKILL.md` — "Committing" section

- Drop `eval-logs/auto-eval-<timestamp>.yaml` from the `git add` command. It only ever stages the round's actual code/suite changes:
  ```bash
  git add api/src/agents/system-prompt.ts api/src/agents/system-prompt.test.ts
  git commit -m "auto-eval round 3: narrow wnav-010 example to cover possessive phrasing"
  ```
- Add an explanatory line: the audit YAML lives under `eval-logs/`, gitignored on purpose — it's a session-scoped working file, not a repo artifact. The durable, reviewable record for a PR is the comment `auto-eval-pr-comment` posts afterward.
- Add a caveat to step 1 ("find or create the log file"): this file only persists for the lifetime of the local checkout. A session resuming the _same_ branch on the _same_ still-alive local clone or cloud container can pick it up from disk; a fresh clone or a new cloud container cannot. This is a known, accepted limitation (see "Future consideration" above), not a bug to work around locally (e.g. don't reach for `git add -f`).

### `auto-eval-pr-comment/SKILL.md`

- Replace the frontmatter sentence "The `eval-logs/` directory is gitignored, so this comment is the only durable, reviewable record of the loop" and the matching body sentence with wording that states this as the intended design, not a workaround for a bug: the loop's audit YAML is a local working file; this comment is what makes the loop's findings durable and reviewable for anyone looking at the PR.
- Fix the stale citation while touching this line: `.gitignore:157` → `.gitignore:163` (current actual line; drifted per the audit doc's §3.7 note).

### Replacement acceptance criteria

In place of the issue's original "`git show --stat` lists `eval-logs/...`" criterion:

1. Running `auto-eval-loop` end to end on a real suite with at least one failure produces a commit whose `git show --stat` lists only that round's code/suite files — no attempted-and-silently-failing `git add` on a gitignored path.
2. `auto-eval-pr-comment`, run afterward **in the same session**, still successfully locates and reads the local `eval-logs/auto-eval-*.yaml` to compose its PR comment.
3. The repeat-check safeguard actually ran and is visible in the log: at least one round's `log[].summary` names a `repeat-check: X/3 failed — treating as real|noise` verdict, and (if any scenario triggered it) the matching `repeatChecks` entries are present.

---

## 4. Testing & verification plan

**Adjacent unit tests (new):** `.agents/skills/auto-eval-loop/test/classify-repeat-check.test.ts` — verdict `real` on 2/3 and 3/3 fail; `noise` on 0/3 and 1/3 fail; `inconclusive` on any `error`/`missing` outcome or an `errored` probe-entry status; correct entry lookup by `(suiteId, model)` when `probe.json` holds multiple entries; a descriptive thrown error for a requested scenario ID absent from the probe's scored scenarios.

**No automated test for `run-repeat-check.sh`**, matching `run-eval-round.sh`'s existing precedent.

**End-to-end verification:** manual, run by the user (not by the agent that implements this — this repo's agent sessions typically have no network path to the local model providers these suites run against). At that point, the implementing session will hand the user a concrete example invocation of `auto-eval-loop` to run locally against a real suite/model/judge combo, so they can confirm all three replacement acceptance criteria above against a real run.
