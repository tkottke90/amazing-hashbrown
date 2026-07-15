import type { EvalRun, ScenarioResult, Scenario } from './schemas.js';

export interface ScenarioComparison {
  scenarioId: string;
  type: Scenario['type'];
  runA: Pick<ScenarioResult, 'passed' | 'score' | 'latencyMs' | 'estimatedCostUsd' | 'details'> | null;
  runB: Pick<ScenarioResult, 'passed' | 'score' | 'latencyMs' | 'estimatedCostUsd' | 'details'> | null;
  change: 'pass→pass' | 'pass→fail' | 'fail→pass' | 'fail→fail' | 'pending' | 'added' | 'removed';
}

export interface ComparisonResult {
  suiteId: string;
  runA: EvalRun;
  runB: EvalRun;
  scenarios: ScenarioComparison[];
  summary: {
    improved: number;
    regressed: number;
    unchanged: number;
    added: number;
    removed: number;
  };
}

function pickResult(
  r: ScenarioResult,
): Pick<ScenarioResult, 'passed' | 'score' | 'latencyMs' | 'estimatedCostUsd' | 'details'> {
  return {
    passed: r.passed,
    score: r.score,
    latencyMs: r.latencyMs,
    estimatedCostUsd: r.estimatedCostUsd,
    details: r.details,
  };
}

function isHumanPending(result: ScenarioResult): boolean {
  return (
    result.details.type === 'human' &&
    (result.details.status === 'pending' || result.details.status === 'skipped')
  );
}

function classifyChange(
  a: ScenarioResult | undefined,
  b: ScenarioResult | undefined,
): ScenarioComparison['change'] {
  if (!a) return 'added';
  if (!b) return 'removed';

  if (isHumanPending(a) || isHumanPending(b)) return 'pending';

  if (a.passed && b.passed) return 'pass→pass';
  if (a.passed && !b.passed) return 'pass→fail';
  if (!a.passed && b.passed) return 'fail→pass';
  return 'fail→fail';
}

export function compareRuns(
  runA: EvalRun,
  resultsA: ScenarioResult[],
  runB: EvalRun,
  resultsB: ScenarioResult[],
): ComparisonResult {
  const mapA = new Map(resultsA.map((r) => [r.scenarioId, r]));
  const mapB = new Map(resultsB.map((r) => [r.scenarioId, r]));
  const allIds = new Set([...mapA.keys(), ...mapB.keys()]);

  const scenarios: ScenarioComparison[] = [];
  let improved = 0;
  let regressed = 0;
  let unchanged = 0;
  let added = 0;
  let removed = 0;

  for (const id of allIds) {
    const a = mapA.get(id);
    const b = mapB.get(id);
    const change = classifyChange(a, b);
    const type = (a ?? b)!.details.type as Scenario['type'];

    scenarios.push({
      scenarioId: id,
      type,
      runA: a ? pickResult(a) : null,
      runB: b ? pickResult(b) : null,
      change,
    });

    switch (change) {
      case 'fail→pass': improved++; break;
      case 'pass→fail': regressed++; break;
      case 'pass→pass': case 'fail→fail': unchanged++; break;
      case 'added': added++; break;
      case 'removed': removed++; break;
    }
  }

  return {
    suiteId: runA.suiteId,
    runA,
    runB,
    scenarios,
    summary: { improved, regressed, unchanged, added, removed },
  };
}
