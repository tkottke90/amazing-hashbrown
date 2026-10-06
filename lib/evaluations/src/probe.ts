import type { EvalRun, ScenarioResult } from './schemas.js';

export type Outcome = 'pass' | 'fail' | 'missing';

export interface ProbeRun {
  run: EvalRun;
  results: ScenarioResult[];
}

export interface ScenarioDeterminism {
  scenarioId: string;
  type: string;
  // True when the judge model took part in scoring this scenario, so a change
  // in outcome can come from the (unseedable, if Claude) judge as well as from
  // the model under test.
  judgeDependent: boolean;
  outcomes: Outcome[];
  varied: boolean;
}

export interface DeterminismAnalysis {
  runCount: number;
  passedPerRun: number[];
  identical: boolean;
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

/**
 * Compares identically-configured runs of one suite scenario by scenario. A
 * scenario "varied" if its pass/fail outcome was not the same in every run;
 * one that is absent from some runs counts as varied.
 */
export function analyzeDeterminism(runs: ProbeRun[]): DeterminismAnalysis {
  const order: string[] = [];
  const meta = new Map<string, { type: string; judgeDependent: boolean }>();
  const perRun = runs.map(({ results }) => {
    const byScenario = new Map<string, boolean>();
    for (const result of results) {
      if (!isScored(result)) continue;
      byScenario.set(result.scenarioId, result.passed);
      if (!meta.has(result.scenarioId)) {
        order.push(result.scenarioId);
        meta.set(result.scenarioId, {
          type: result.details.type,
          judgeDependent: isJudgeDependent(result),
        });
      }
    }
    return byScenario;
  });

  const scenarios = order.map((scenarioId): ScenarioDeterminism => {
    const outcomes = perRun.map((byScenario): Outcome => {
      const passed = byScenario.get(scenarioId);
      if (passed === undefined) return 'missing';
      return passed ? 'pass' : 'fail';
    });
    const { type, judgeDependent } = meta.get(scenarioId)!;
    return {
      scenarioId,
      type,
      judgeDependent,
      outcomes,
      varied: new Set(outcomes).size > 1,
    };
  });

  return {
    runCount: runs.length,
    passedPerRun: perRun.map((byScenario) => [...byScenario.values()].filter(Boolean).length),
    identical: scenarios.every((s) => !s.varied),
    scenarios,
  };
}

/** 1 if anything varied, else 3 if anything errored, else 0. */
export function probeExitCode(entries: ProbeEntry[]): 0 | 1 | 3 {
  if (entries.some((e) => e.status === 'analyzed' && !e.analysis.identical)) return 1;
  if (entries.some((e) => e.status === 'errored')) return 3;
  return 0;
}

const OUTCOME_GLYPH: Record<Outcome, string> = { pass: 'P', fail: 'F', missing: '-' };

export function formatProbeReport(
  entries: ProbeEntry[],
  options: { aborted?: boolean } = {},
): string {
  const lines: string[] = [`Determinism probe — ${entries.length} suite/model pair(s)`, ''];
  let targetOnly = 0;
  let judgeDependent = 0;

  for (const entry of entries) {
    const label = `${entry.model} / ${entry.suiteId}`;
    if (entry.status === 'errored') {
      lines.push(`  ERRORED    ${label} — ${entry.reason}`);
      continue;
    }
    const { analysis } = entry;
    const verdict = analysis.identical ? 'IDENTICAL' : 'VARIED   ';
    lines.push(
      `  ${verdict} ${label} — ${analysis.runCount} runs, passed per run: ${analysis.passedPerRun.join(' ')}`,
    );
    for (const s of analysis.scenarios.filter((x) => x.varied)) {
      const glyphs = s.outcomes.map((o) => OUTCOME_GLYPH[o]).join(' ');
      lines.push(
        `      ${s.scenarioId.padEnd(28)} ${glyphs}  [${s.type}${s.judgeDependent ? ', judge-dependent' : ''}]`,
      );
      if (s.judgeDependent) judgeDependent += 1;
      else targetOnly += 1;
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
    lines.push('Overall: INCOMPLETE — some pairs errored, and none of the rest varied.');
  } else {
    lines.push('Overall: VARIED — identical runs disagreed on at least one scenario.');
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
        'or the judge. Anthropic has no seed parameter, so some variance from a Claude judge ' +
        'is expected.',
    );
  }
  return lines.join('\n');
}
