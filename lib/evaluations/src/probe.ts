import { getFailureCategory, type FailureCategory } from './failure-category.js';
import type { EvalRun, ScenarioResult } from './schemas.js';

// 'error' means the scenario threw (a model or judge call failed), which is a
// harness/provider failure rather than model behaviour — runner.ts records it
// as an ordinary failed result, so it has to be recognised separately here.
export type Outcome = 'pass' | 'fail' | 'error' | 'missing';

export interface ProbeRun {
  run: EvalRun;
  results: ScenarioResult[];
}

export interface ScenarioDeterminism {
  scenarioId: string;
  // 'unknown' when the scenario errored in every run: the runner replaces an
  // errored scenario's details with a placeholder, so its real type is lost.
  type: string;
  // True when the judge model took part in scoring this scenario, so a change
  // in outcome can come from the (unseedable, if Claude) judge as well as from
  // the model under test.
  judgeDependent: boolean;
  outcomes: Outcome[];
  varied: boolean;
  // The first error's message, when any run's outcome was 'error'.
  errorMessage?: string;
  // How many runs this scenario's result carried each failure category (see
  // failure-category.ts). Present only when at least one did. Independent of
  // `outcomes`: a scenario can fail identically in every run while the cause
  // differs between them (e.g. a clean wrong-tool call in one run, a
  // non-existent tool name in the next), which `outcomes` alone cannot show.
  categories?: Partial<Record<FailureCategory, number>>;
}

export interface DeterminismAnalysis {
  runCount: number;
  passedPerRun: number[];
  // True when no scenario's outcome differed between runs. A scenario that
  // errors identically in every run is still "identical" — see `errored`.
  identical: boolean;
  // True when any scenario errored in any run; such a result is untrustworthy
  // even if the outcomes agree.
  errored: boolean;
  scenarios: ScenarioDeterminism[];
}

export type ProbeEntry =
  | { suiteId: string; model: string; status: 'analyzed'; analysis: DeterminismAnalysis }
  | { suiteId: string; model: string; status: 'errored'; reason: string };

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

/**
 * Pulls the result YAML path out of `bin/eval.ts` console output — the last
 * `Result:  <path>.yaml` line, the same contract run-eval-round.sh relies on.
 */
export function parseResultPath(output: string): string | undefined {
  const matches = [...output.replace(ANSI_ESCAPE, '').matchAll(/Result:\s+(\S+\.yaml)/g)];
  return matches.at(-1)?.[1];
}

const MAX_REASON_LENGTH = 200;

function clip(text: string): string {
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH - 1)}…` : text;
}

function formatIssue(issue: unknown): string {
  const { path, message } = (issue ?? {}) as { path?: unknown; message?: unknown };
  const where = Array.isArray(path) ? path.join('.') : '';
  const what = typeof message === 'string' ? message : 'invalid';
  return where ? `${where}: ${what}` : what;
}

/**
 * One line describing a failure, for the probe report. A schema validation
 * error (anything carrying an `issues` array, e.g. ZodError) is summarised as
 * its first issues' `path: message` — its own `.message` is a multi-line JSON
 * dump that is unreadable in a report. Anything else is its first non-empty
 * line.
 */
export function describeError(err: unknown): string {
  const issues =
    typeof err === 'object' && err !== null ? (err as { issues?: unknown }).issues : undefined;
  if (Array.isArray(issues) && issues.length > 0) {
    const more = issues.length > 2 ? ` (+${issues.length - 2} more)` : '';
    return clip(`${issues.slice(0, 2).map(formatIssue).join('; ')}${more}`);
  }
  const message = err instanceof Error ? err.message : String(err);
  const firstLine = message
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return clip(firstLine ?? 'unknown error');
}

// Mirrors the `scorable` filter in computeRunSummary (runner.ts): skipped and
// still-pending human results are not part of a run's pass/fail denominator.
function isScored(result: ScenarioResult): boolean {
  const d = result.details;
  if (d.type === 'skipped') return false;
  if (d.type === 'human' && (d.status === 'pending' || d.status === 'skipped')) return false;
  return true;
}

function isJudgeDependent(result: ScenarioResult): boolean {
  const d = result.details;
  if (d.type === 'llm-judge') return true;
  if (d.type === 'tool-call') return d.responseJudge !== undefined;
  if (d.type === 'tool-sequence' && d.responseJudge !== undefined) return true;
  if (d.type === 'deterministic' || d.type === 'tool-sequence') {
    // Multi-step scenarios can judge individual steps even when the scenario's
    // own type does not.
    return (
      d.steps?.some(
        (step) =>
          step.details.type === 'llm-judge' ||
          ('responseJudge' in step.details && step.details.responseJudge !== undefined),
      ) ?? false
    );
  }
  return false;
}

// The prefix runner.ts (executeScenario's catch) puts on `actualOutput` when a
// scenario throws instead of producing a result.
const SCENARIO_ERROR_PREFIX = '[scenario error]';

function scenarioError(result: ScenarioResult): string | undefined {
  if (!result.actualOutput.startsWith(SCENARIO_ERROR_PREFIX)) return undefined;
  return describeError(new Error(result.actualOutput.slice(SCENARIO_ERROR_PREFIX.length)));
}

/**
 * Compares identically-configured runs of one suite scenario by scenario. A
 * scenario "varied" if its outcome was not the same in every run; one that is
 * absent from some runs counts as varied. A scenario that threw is an
 * 'error' outcome, not a 'fail', and flags the whole analysis as `errored`.
 */
export function analyzeDeterminism(runs: ProbeRun[]): DeterminismAnalysis {
  const order: string[] = [];
  // Taken from a run where the scenario actually ran: an errored scenario's
  // `details` is the runner's placeholder, which would mislabel its type.
  const meta = new Map<string, { type: string; judgeDependent: boolean }>();
  const errorMessages = new Map<string, string>();
  const categoryCounts = new Map<string, Partial<Record<FailureCategory, number>>>();
  const perRun = runs.map(({ results }) => {
    const byScenario = new Map<string, Outcome>();
    for (const result of results) {
      if (!isScored(result)) continue;
      const error = scenarioError(result);
      byScenario.set(result.scenarioId, error ? 'error' : result.passed ? 'pass' : 'fail');
      if (!order.includes(result.scenarioId)) order.push(result.scenarioId);
      const category = error ? null : getFailureCategory(result.details);
      if (category) {
        const counts = categoryCounts.get(result.scenarioId) ?? {};
        counts[category] = (counts[category] ?? 0) + 1;
        categoryCounts.set(result.scenarioId, counts);
      }
      if (error) {
        if (!errorMessages.has(result.scenarioId)) errorMessages.set(result.scenarioId, error);
      } else if (!meta.has(result.scenarioId)) {
        meta.set(result.scenarioId, {
          type: result.details.type,
          judgeDependent: isJudgeDependent(result),
        });
      }
    }
    return byScenario;
  });

  const scenarios = order.map((scenarioId): ScenarioDeterminism => {
    const outcomes = perRun.map((byScenario): Outcome => byScenario.get(scenarioId) ?? 'missing');
    const { type, judgeDependent } = meta.get(scenarioId) ?? {
      type: 'unknown',
      judgeDependent: false,
    };
    const errorMessage = errorMessages.get(scenarioId);
    const categories = categoryCounts.get(scenarioId);
    return {
      scenarioId,
      type,
      judgeDependent,
      outcomes,
      varied: new Set(outcomes).size > 1,
      ...(errorMessage === undefined ? {} : { errorMessage }),
      ...(categories === undefined ? {} : { categories }),
    };
  });

  return {
    runCount: runs.length,
    passedPerRun: perRun.map(
      (byScenario) => [...byScenario.values()].filter((o) => o === 'pass').length,
    ),
    identical: scenarios.every((s) => !s.varied),
    errored: scenarios.some((s) => s.errorMessage !== undefined),
    scenarios,
  };
}

/**
 * 1 if anything varied; else 3 if any pair or scenario errored (the result
 * can't be trusted); else 0.
 */
export function probeExitCode(entries: ProbeEntry[]): 0 | 1 | 3 {
  if (entries.some((e) => e.status === 'analyzed' && !e.analysis.identical)) return 1;
  if (entries.some((e) => e.status === 'errored' || e.analysis.errored)) return 3;
  return 0;
}

const OUTCOME_GLYPH: Record<Outcome, string> = { pass: 'P', fail: 'F', error: 'E', missing: '-' };

export function formatProbeReport(
  entries: ProbeEntry[],
  options: { aborted?: boolean } = {},
): string {
  const lines: string[] = [`Determinism probe — ${entries.length} suite/model pair(s)`, ''];
  let targetOnly = 0;
  let judgeDependent = 0;
  let erroredScenarios = 0;
  let categorisedScenarios = 0;

  for (const entry of entries) {
    const label = `${entry.model} / ${entry.suiteId}`;
    if (entry.status === 'errored') {
      lines.push(`  ERRORED    ${label} — ${entry.reason}`);
      continue;
    }
    const { analysis } = entry;
    const verdict = !analysis.identical
      ? 'VARIED    '
      : analysis.errored
        ? 'HAD ERRORS'
        : 'IDENTICAL ';
    lines.push(
      `  ${verdict} ${label} — ${analysis.runCount} runs, passed per run: ${analysis.passedPerRun.join(' ')}`,
    );
    const listed = analysis.scenarios.filter(
      (x) => x.varied || x.errorMessage !== undefined || x.categories !== undefined,
    );
    for (const s of listed) {
      const glyphs = s.outcomes.map((o) => OUTCOME_GLYPH[o]).join(' ');
      lines.push(
        `      ${s.scenarioId.padEnd(28)} ${glyphs}  [${s.type}${s.judgeDependent ? ', judge-dependent' : ''}]`,
      );
      if (s.errorMessage !== undefined) {
        lines.push(`          error: ${s.errorMessage}`);
        erroredScenarios += 1;
      }
      if (s.categories !== undefined) {
        const seen = Object.entries(s.categories)
          .map(([category, n]) => `${category} in ${n}/${analysis.runCount} runs`)
          .join(', ');
        lines.push(`          categories: ${seen}`);
        categorisedScenarios += 1;
      }
      if (s.varied) {
        if (s.judgeDependent) judgeDependent += 1;
        else targetOnly += 1;
      }
    }
  }

  const exit = probeExitCode(entries);
  lines.push('');
  if (options.aborted) {
    lines.push(
      'Overall: ABORTED — the probe stopped early on a usage/config error, so there is no verdict. ' +
        'Any pairs listed above are partial.',
    );
  } else if (exit === 0) {
    lines.push('Overall: IDENTICAL — every scenario had the same outcome in every run.');
  } else if (exit === 3) {
    lines.push('Overall: INCOMPLETE — some pairs or scenarios errored, and nothing varied.');
  } else {
    lines.push('Overall: VARIED — identical runs disagreed on at least one scenario.');
  }
  if (erroredScenarios > 0) {
    lines.push(
      `  ${erroredScenarios} scenario(s) errored rather than failed (E): a model or judge call threw. ` +
        'That is a harness or provider problem, not model behaviour, and a scenario that errors ' +
        'every run looks identical — fix these before trusting any verdict.',
    );
  }
  if (categorisedScenarios > 0) {
    lines.push(
      `  ${categorisedScenarios} scenario(s) hit a failure category: the model or its server produced ` +
        'a broken or non-existent tool call, or asked in prose, rather than making a routing ' +
        'choice. Categories never change the verdict above, and a scenario is listed here even ' +
        'when its outcome never varied, because the cause can differ between runs.',
    );
  }
  if (targetOnly > 0) {
    lines.push(
      `  ${targetOnly} varied scenario(s) do not use the judge, so the model under test itself ` +
        'changed output between identical runs. A provider that varies while another is ' +
        'stable points at that server ignoring `seed`; variance on every provider points ' +
        'at the harness change.',
    );
  }
  if (judgeDependent > 0) {
    lines.push(
      `  ${judgeDependent} varied scenario(s) are judge-dependent: they can vary from the model ` +
        'or the judge. Anthropic has no seed parameter and current Claude models reject an ' +
        'explicit temperature, so a Claude judge is unpinned and some variance is expected.',
    );
  }
  return lines.join('\n');
}
