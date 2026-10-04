# Eval scoring: carry the real denominator through reports — Design

**Date:** 2026-10-04
**Status:** Draft
**Related:** [Issue #229](https://github.com/tkottke90/amazing-hashbrown/issues/229)

---

## Goal

`passedScenarios/totalScenarios`, as shown in the CLI summary, the HTML report, and the `auto-eval-loop` skill's score line, should match the denominator `passRate` actually uses — so a clean run of a suite with one skipped `human` scenario reads as `3/3 (1 skipped)`, not `3/4`.

---

## Problem

`computeRunSummary()` in `lib/evaluations/src/runner.ts` filters out `skipped` and pending/skipped `human` results into `scorable` before computing `passRate`, but reports `totalScenarios: results.length` — the unfiltered count. Every consumer that builds an "X/Y" display uses `passedScenarios` over `totalScenarios`, so the fraction shown doesn't match the fraction `passRate` was computed from. This previously caused a wrong diagnosis in review (tkottke90/amazing-hashbrown#224): a `wiki-search` run reading `3/4` was misread as "one scenario away from failing," when the real ceiling (over scorable scenarios) was `3/3`.

---

## Non-goals

- Changing how scenarios get excluded from scoring (the `scorable` filter in `computeRunSummary` is correct today and is not touched).
- Backfilling historical DB rows with a computed `scoredScenarios` value. Old rows simply don't have this information in a reliably recoverable form; they fall back to `totalScenarios`, same as old YAML result files.
- Surfacing the skipped count in the multi-suite batch summary table (`bin/eval.ts`'s no-`--suite` run) or in `eval:compare`'s output. Both are out of scope per explicit decision — the comparator already carries `EvalRun` through untouched, so it round-trips the new field for free if a future change wants to display it there.

---

## Design

### 1. `lib/evaluations/src/schemas.ts`

Add one optional field to `EvalRunSchema`:

```ts
scoredScenarios: z.number().int().optional(),
```

Optional so existing YAML result files and existing `eval_runs` DB rows — neither of which has this field — still parse.

### 2. `lib/evaluations/src/runner.ts`

`computeRunSummary` already computes `scorable` (the array `passRate` is derived from). Expose its length instead of recomputing anything:

```ts
return {
  ...
  totalScenarios: results.length,
  scoredScenarios: scorable.length,
  passedScenarios,
  ...
};
```

Add and export one small helper, used by every display site below instead of each one repeating the fallback:

```ts
export function getScoredScenarios(run: EvalRun): number {
  return run.scoredScenarios ?? run.totalScenarios;
}
```

### 3. `lib/evaluations/src/store.ts`

New migration, version 37.

> **Correction (found during implementation planning):** this doc originally said version 9, treating `store.ts`'s own `MIGRATIONS` array as if it were the whole picture. It isn't — `schema_migrations` is one table shared by every store on the connection (`BaseStore.runMigrations`), and version 9 is already claimed by `lib/observability/src/store.ts`, with versions in use climbing to 36 elsewhere (`api/src/services/workspace-store.ts`). Version 9 would have silently never run. 37 is the next free number across the whole repo as of this writing.

```ts
{
  // Surfaces the scorable-scenario denominator passRate was actually
  // computed from (see runner.ts's computeRunSummary / getScoredScenarios).
  // Nullable, no backfill: existing rows read back as NULL and fall through
  // getScoredScenarios() to totalScenarios, same as pre-existing YAML files.
  version: 37,
  sql: `ALTER TABLE eval_runs ADD COLUMN scored_scenarios INTEGER;`,
},
```

Update `saveRun`'s `INSERT` (column list + `run.scoredScenarios ?? null`), `RawEvalRunSchema` (`scored_scenarios: z.number().nullable()`), and its `.transform()` (`scoredScenarios: row.scored_scenarios ?? undefined`) to carry the column through `findRunById`/`findRuns`.

### 4. Display sites

- **`bin/eval.ts`** (single-suite summary, ~line 379): change

  ```ts
  `  Pass rate: ${(run.passRate * 100).toFixed(1)}%  (${run.passedScenarios}/${run.totalScenarios} scenarios)`;
  ```

  to use `getScoredScenarios(run)` as the denominator, and append a skip note when `run.totalScenarios > scored`:

  ```ts
  const scored = getScoredScenarios(run);
  const skipped = run.totalScenarios - scored;
  const skipNote = skipped > 0 ? ` (${skipped} skipped)` : '';
  console.log(
    `  Pass rate: ${(run.passRate * 100).toFixed(1)}%  (${run.passedScenarios}/${scored} scenarios)${skipNote}`,
  );
  ```

- **`lib/evaluations/templates/partials/suite-summary.njk`** is only ever rendered from `writeResultHtml()` in `serializer.ts` (`env.render('result.njk', { run, results, suiteName, scenariosById, styles })`, which the partial inherits via Nunjucks `include`). Nunjucks templates can't import `getScoredScenarios`, so `writeResultHtml` computes `scored`/`skipped` the same way the CLI does and adds them to the render context:

  ```ts
  const scored = getScoredScenarios(run);
  const skipped = run.totalScenarios - scored;
  const html = env.render('result.njk', {
    run,
    results,
    suiteName: suite.suite.name,
    scenariosById,
    styles,
    scored,
    skipped,
  });
  ```

  `suite-summary.njk`'s stat changes from `{{ run.passedScenarios }} / {{ run.totalScenarios }}` to:

  ```
  {{ run.passedScenarios }} / {{ scored }}{% if skipped %} <span class="skip-note">({{ skipped }} skipped)</span>{% endif %}
  ```

- **`result.njk`**'s status bar only shows `passRate` as a percentage (no fraction), so it's already consistent with the fixed denominator — no change needed there.

### 5. `.agents/skills/auto-eval-loop/SKILL.md`

Update the field-notes paragraph (~line 150-151) that currently reads:

> `score` / `total`: ... both come straight from the result YAML's `run.passedScenarios` / `run.totalScenarios`.

to point `total` at `run.scoredScenarios` (falling back to `totalScenarios` for older result files per `getScoredScenarios`'s behavior), so the skill's own score line stops inheriting the same mismatch.

---

## Error handling

No new error paths. The new field is optional everywhere it's read (schema, DB column, template context); every consumer goes through `getScoredScenarios()`'s `??` fallback rather than assuming the field is present. No behavior changes for `passRate` or `passed` — only the displayed counts change.

---

## Testing

- `lib/evaluations/test/unit/runner.test.ts`: update the two existing tests (`'counts skipped results in totalScenarios but excludes them from passRate'`, `'a failing non-skipped scenario still counts against passRate alongside a skip'`) to also assert `run.scoredScenarios`. Add one new test matching acceptance criterion #4 verbatim: a suite with one skipped `human` scenario reports `scoredScenarios` one less than `totalScenarios`, with `passRate` computed consistently against `scoredScenarios`.
- `lib/evaluations/test/unit/store.test.ts`: add a case asserting a row with `scored_scenarios IS NULL` (simulating a pre-migration row) round-trips with `scoredScenarios: undefined`, and a case asserting a freshly-saved run's `scoredScenarios` round-trips exactly.
- `lib/evaluations/test/unit/schemas.test.ts`: confirm `EvalRunSchema` still parses a fixture without `scoredScenarios` (back-compat) and one with it.
- No `suites/*.yaml` changes — this is harness-internals scoring/reporting math, not LLM-facing behavior, so the EDD "write a failing eval first" rule doesn't apply (consistent with how `AGENTS.md` scopes that rule).
