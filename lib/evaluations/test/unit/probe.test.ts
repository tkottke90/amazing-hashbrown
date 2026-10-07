import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import {
  analyzeDeterminism,
  describeError,
  formatProbeReport,
  parseResultPath,
  probeExitCode,
  type ProbeEntry,
  type ProbeRun,
} from '../../src/probe.js';
import type { EvalRun, ScenarioResult } from '../../src/schemas.js';

function makeRun(id: string): EvalRun {
  return {
    id,
    suiteId: 'test-suite',
    model: 'model-a',
    startedAt: '2026-10-06T00:00:00.000Z',
    passed: true,
    passRate: 1,
    totalScenarios: 1,
    passedScenarios: 1,
    totalLatencyMs: 100,
    estimatedCostUsd: 0,
  };
}

function makeResult(
  scenarioId: string,
  passed: boolean,
  details: ScenarioResult['details'] = {
    type: 'deterministic',
    match: 'contains',
    expected: 'x',
    passed,
  },
  actualOutput = '',
): ScenarioResult {
  return {
    id: `${scenarioId}-result`,
    runId: 'run',
    scenarioId,
    suiteId: 'test-suite',
    passed,
    score: passed ? 1 : 0,
    actualOutput,
    latencyMs: 1,
    estimatedCostUsd: 0,
    details,
  };
}

// What runner.ts's executeScenario returns when a scenario throws: a failed
// result with a placeholder `deterministic` detail and a marked actualOutput.
function makeErroredResult(scenarioId: string, message: string): ScenarioResult {
  return makeResult(
    scenarioId,
    false,
    { type: 'deterministic', match: 'exact', expected: '', passed: false },
    `[scenario error] ${message}`,
  );
}

function probeRuns(...perRun: ScenarioResult[][]): ProbeRun[] {
  return perRun.map((results, i) => ({ run: makeRun(`run-${i}`), results }));
}

const judgeDetails = { score: 8, minScore: 6, reasoning: 'ok', judgeModel: 'j', biasRisk: false };

describe('parseResultPath', () => {
  it('returns the path from a Result line [unit]', () => {
    const out = '  ✓ PASS — suite\n  Result:    /repo/eval-results/suite-2026.yaml\n';
    assert.equal(parseResultPath(out), '/repo/eval-results/suite-2026.yaml');
  });

  it('returns the last path when several suites printed one [unit]', () => {
    const out = 'Result: /a/one.yaml\nResult:    /a/two.yaml\n';
    assert.equal(parseResultPath(out), '/a/two.yaml');
  });

  it('ignores the HTML report line [unit]', () => {
    const out = 'Result:    /a/run.yaml\nReport:    /a/run.html\n';
    assert.equal(parseResultPath(out), '/a/run.yaml');
  });

  it('returns undefined when no Result line was printed [unit]', () => {
    assert.equal(parseResultPath('Error creating model: boom'), undefined);
  });

  it('still finds the path when ANSI escape codes surround it [unit]', () => {
    const esc = String.fromCharCode(27);
    const out = `${esc}[2K${esc}[1AResult:    /a/run.yaml${esc}[0m\n`;
    assert.equal(parseResultPath(out), '/a/run.yaml');
  });
});

describe('describeError', () => {
  it('summarises a schema error by the path and message of its issues, not its JSON dump [unit]', () => {
    const err = Object.assign(new Error('[\n  {\n    "code": "invalid_type"\n  }\n]'), {
      issues: [
        {
          path: ['details', 'fieldResults', 0, 'expected'],
          message: 'Invalid input: expected nonoptional, received undefined',
        },
      ],
    });
    assert.equal(
      describeError(err),
      'details.fieldResults.0.expected: Invalid input: expected nonoptional, received undefined',
    );
  });

  it('shows the first two issues and counts the rest [unit]', () => {
    const err = {
      issues: [
        { path: ['a'], message: 'one' },
        { path: ['b'], message: 'two' },
        { path: ['c'], message: 'three' },
        { path: ['d'], message: 'four' },
      ],
    };
    assert.equal(describeError(err), 'a: one; b: two (+2 more)');
  });

  it('omits the path prefix when an issue has no path [unit]', () => {
    assert.equal(describeError({ issues: [{ path: [], message: 'bad file' }] }), 'bad file');
  });

  it('uses only the first non-empty line of an ordinary error [unit]', () => {
    assert.equal(
      describeError(new Error('\n  ENOENT: no such file\n    at somewhere')),
      'ENOENT: no such file',
    );
  });

  it('handles a thrown string and an empty message [unit]', () => {
    assert.equal(describeError('plain string'), 'plain string');
    assert.equal(describeError(new Error('')), 'unknown error');
  });

  it('truncates a very long message to a single bounded line [unit]', () => {
    const out = describeError(new Error('x'.repeat(500)));
    assert.equal(out.length, 200);
    assert.ok(out.endsWith('…'));
  });
});

describe('analyzeDeterminism', () => {
  it('reports identical when every scenario has the same outcome in every run [unit]', () => {
    const analysis = analyzeDeterminism(
      probeRuns(
        [makeResult('a', true), makeResult('b', false)],
        [makeResult('a', true), makeResult('b', false)],
        [makeResult('a', true), makeResult('b', false)],
      ),
    );
    assert.equal(analysis.identical, true);
    assert.equal(analysis.runCount, 3);
    assert.deepEqual(analysis.passedPerRun, [1, 1, 1]);
    assert.ok(analysis.scenarios.every((s) => !s.varied));
  });

  it('treats a consistently failing scenario as stable, not varied [unit]', () => {
    const analysis = analyzeDeterminism(
      probeRuns([makeResult('a', false)], [makeResult('a', false)]),
    );
    assert.equal(analysis.identical, true);
  });

  it('flags only the scenario whose outcome changed between runs [unit]', () => {
    const analysis = analyzeDeterminism(
      probeRuns(
        [makeResult('a', true), makeResult('b', true)],
        [makeResult('a', true), makeResult('b', false)],
        [makeResult('a', true), makeResult('b', true)],
      ),
    );
    assert.equal(analysis.identical, false);
    const byId = Object.fromEntries(analysis.scenarios.map((s) => [s.scenarioId, s]));
    assert.equal(byId.a!.varied, false);
    assert.equal(byId.b!.varied, true);
    assert.deepEqual(byId.b!.outcomes, ['pass', 'fail', 'pass']);
  });

  it('flags varied scenarios even when the pass counts happen to match [unit]', () => {
    const analysis = analyzeDeterminism(
      probeRuns(
        [makeResult('a', true), makeResult('b', false)],
        [makeResult('a', false), makeResult('b', true)],
      ),
    );
    assert.deepEqual(analysis.passedPerRun, [1, 1]);
    assert.equal(analysis.identical, false);
  });

  it('counts a scenario missing from some runs as varied [unit]', () => {
    const analysis = analyzeDeterminism(
      probeRuns([makeResult('a', true), makeResult('b', true)], [makeResult('a', true)]),
    );
    const b = analysis.scenarios.find((s) => s.scenarioId === 'b')!;
    assert.deepEqual(b.outcomes, ['pass', 'missing']);
    assert.equal(b.varied, true);
    assert.equal(analysis.identical, false);
  });

  it('excludes skipped and pending/skipped human results, as run scoring does [unit]', () => {
    const analysis = analyzeDeterminism(
      probeRuns(
        [
          makeResult('a', true),
          makeResult('skip', false, { type: 'skipped' }),
          makeResult('h-pending', false, { type: 'human', status: 'pending' }),
          makeResult('h-skipped', false, { type: 'human', status: 'skipped' }),
        ],
        [makeResult('a', true)],
      ),
    );
    assert.deepEqual(
      analysis.scenarios.map((s) => s.scenarioId),
      ['a'],
    );
    assert.equal(analysis.identical, true);
  });

  it('keeps an approved human scenario in scope [unit]', () => {
    const analysis = analyzeDeterminism(
      probeRuns(
        [makeResult('h', true, { type: 'human', status: 'approved' })],
        [makeResult('h', true, { type: 'human', status: 'approved' })],
      ),
    );
    assert.deepEqual(
      analysis.scenarios.map((s) => s.scenarioId),
      ['h'],
    );
  });

  describe('judge dependence', () => {
    function judgeFlagOf(details: ScenarioResult['details']): boolean {
      const analysis = analyzeDeterminism(
        probeRuns([makeResult('s', true, details)], [makeResult('s', true, details)]),
      );
      return analysis.scenarios[0]!.judgeDependent;
    }

    const toolBase = {
      expectedTool: 't',
      toolCalled: 't',
      fieldResults: [],
      score: 1,
    };

    it('marks llm-judge scenarios as judge-dependent [unit]', () => {
      assert.equal(
        judgeFlagOf({
          type: 'llm-judge',
          judgeModel: 'j',
          score: 8,
          reasoning: 'ok',
          biasRisk: false,
        }),
        true,
      );
    });

    it('marks a tool-call scenario with a responseJudge as judge-dependent [unit]', () => {
      assert.equal(
        judgeFlagOf({ type: 'tool-call', ...toolBase, responseJudge: judgeDetails }),
        true,
      );
    });

    it('does not mark a tool-call scenario without a responseJudge [unit]', () => {
      assert.equal(judgeFlagOf({ type: 'tool-call', ...toolBase }), false);
    });

    it('marks a tool-sequence scenario with a responseJudge as judge-dependent [unit]', () => {
      assert.equal(
        judgeFlagOf({ type: 'tool-sequence', ...toolBase, responseJudge: judgeDetails }),
        true,
      );
    });

    it('marks a multi-step scenario judge-dependent when any step used the judge [unit]', () => {
      assert.equal(
        judgeFlagOf({
          type: 'deterministic',
          match: 'contains',
          expected: 'x',
          passed: true,
          steps: [
            {
              index: 0,
              actualOutput: '',
              latencyMs: 1,
              passed: true,
              score: 1,
              details: {
                type: 'llm-judge',
                judgeModel: 'j',
                score: 8,
                reasoning: 'ok',
                biasRisk: false,
              },
            },
          ],
        }),
        true,
      );
    });

    it('does not mark deterministic or structured scenarios [unit]', () => {
      assert.equal(
        judgeFlagOf({ type: 'deterministic', match: 'contains', expected: 'x', passed: true }),
        false,
      );
      assert.equal(judgeFlagOf({ type: 'structured', fieldResults: [], score: 1 }), false);
    });
  });
});

describe('probeExitCode', () => {
  const identical: ProbeEntry = {
    suiteId: 's',
    model: 'm',
    status: 'analyzed',
    analysis: { runCount: 2, passedPerRun: [1, 1], identical: true, errored: false, scenarios: [] },
  };
  const varied: ProbeEntry = {
    suiteId: 's2',
    model: 'm',
    status: 'analyzed',
    analysis: {
      runCount: 2,
      passedPerRun: [1, 0],
      identical: false,
      errored: false,
      scenarios: [],
    },
  };
  const scenarioErrors: ProbeEntry = {
    suiteId: 's4',
    model: 'm',
    status: 'analyzed',
    analysis: { runCount: 2, passedPerRun: [0, 0], identical: true, errored: true, scenarios: [] },
  };
  const errored: ProbeEntry = { suiteId: 's3', model: 'm', status: 'errored', reason: 'boom' };

  it('is 0 when every pair was identical [unit]', () => {
    assert.equal(probeExitCode([identical]), 0);
  });

  it('is 1 when any pair varied, even if another pair errored [unit]', () => {
    assert.equal(probeExitCode([identical, varied, errored]), 1);
  });

  it('is 3 when a pair errored and nothing varied, so an incomplete probe never reads as a pass [unit]', () => {
    assert.equal(probeExitCode([identical, errored]), 3);
  });

  it('is 3 when scenarios errored identically in every run, so a broken judge never reads as a pass [unit]', () => {
    assert.equal(probeExitCode([identical, scenarioErrors]), 3);
  });

  it('is still 1 when something varied alongside scenario errors [unit]', () => {
    assert.equal(probeExitCode([scenarioErrors, varied]), 1);
  });
});

describe('errored scenarios', () => {
  const judgeError =
    'Judge model "anthropic" does not support structured output or failed to respond after retries: Error: 400 `temperature` is deprecated for this model.';

  it('records a scenario that threw as an error outcome, not a failure [unit]', () => {
    const analysis = analyzeDeterminism(
      probeRuns([makeErroredResult('s', judgeError)], [makeErroredResult('s', judgeError)]),
    );
    assert.deepEqual(analysis.scenarios[0]!.outcomes, ['error', 'error']);
    assert.equal(analysis.errored, true);
  });

  it('does not count an errored scenario as passed [unit]', () => {
    const analysis = analyzeDeterminism(
      probeRuns(
        [makeResult('ok', true), makeErroredResult('s', judgeError)],
        [makeResult('ok', true), makeErroredResult('s', judgeError)],
      ),
    );
    assert.deepEqual(analysis.passedPerRun, [1, 1]);
  });

  it('keeps an identical error in every run "identical" but flags the analysis as errored [unit]', () => {
    const analysis = analyzeDeterminism(
      probeRuns([makeErroredResult('s', judgeError)], [makeErroredResult('s', judgeError)]),
    );
    assert.equal(analysis.identical, true);
    assert.equal(analysis.errored, true);
  });

  it('treats a scenario that errored in one run and passed in another as varied [unit]', () => {
    const analysis = analyzeDeterminism(
      probeRuns([makeErroredResult('s', 'timeout')], [makeResult('s', true)]),
    );
    assert.deepEqual(analysis.scenarios[0]!.outcomes, ['error', 'pass']);
    assert.equal(analysis.scenarios[0]!.varied, true);
  });

  it('takes the scenario type from a run where it actually ran, not the error placeholder [unit]', () => {
    const toolCall = {
      type: 'tool-call' as const,
      expectedTool: 't',
      toolCalled: 't',
      fieldResults: [],
      score: 1,
      responseJudge: { score: 8, minScore: 6, reasoning: 'ok', judgeModel: 'j', biasRisk: false },
    };
    const analysis = analyzeDeterminism(
      probeRuns([makeErroredResult('s', 'boom')], [makeResult('s', true, toolCall)]),
    );
    assert.equal(analysis.scenarios[0]!.type, 'tool-call');
    assert.equal(analysis.scenarios[0]!.judgeDependent, true);
  });

  it('labels the type unknown when a scenario errored in every run [unit]', () => {
    const analysis = analyzeDeterminism(
      probeRuns([makeErroredResult('s', 'boom')], [makeErroredResult('s', 'boom')]),
    );
    assert.equal(analysis.scenarios[0]!.type, 'unknown');
  });

  it('keeps only the first line of a multi-line error message [unit]', () => {
    const analysis = analyzeDeterminism(
      probeRuns([makeErroredResult('s', '\n  first line\n  second line')], [makeResult('s', true)]),
    );
    assert.equal(analysis.scenarios[0]!.errorMessage, 'first line');
  });

  it('does not flag a scenario that merely failed as errored [unit]', () => {
    const analysis = analyzeDeterminism(
      probeRuns([makeResult('s', false)], [makeResult('s', false)]),
    );
    assert.equal(analysis.errored, false);
    assert.equal(analysis.scenarios[0]!.errorMessage, undefined);
  });

  it('shows errored scenarios in the report even when every run agreed [unit]', () => {
    const analysis = analyzeDeterminism(
      probeRuns(
        [makeErroredResult('tc-003', judgeError)],
        [makeErroredResult('tc-003', judgeError)],
      ),
    );
    const report = formatProbeReport([
      { suiteId: 'task-creation', model: 'local', status: 'analyzed', analysis },
    ]);
    assert.match(report, /HAD ERRORS\s+local \/ task-creation/);
    assert.match(report, /tc-003\s+E E/);
    assert.match(report, /error: Judge model "anthropic".*temperature/);
    assert.match(report, /errored rather than failed/);
    assert.match(report, /Overall: INCOMPLETE/);
    assert.doesNotMatch(report, /Overall: IDENTICAL/);
  });
});

describe('formatProbeReport', () => {
  const variedAnalysis = analyzeDeterminism(
    probeRuns(
      [makeResult('stable', true), makeResult('flaky-target', true)],
      [makeResult('stable', true), makeResult('flaky-target', false)],
    ),
  );

  it('lists each varied scenario with its per-run outcomes [unit]', () => {
    const report = formatProbeReport([
      {
        suiteId: 'wiki-navigation',
        model: 'lemonade',
        status: 'analyzed',
        analysis: variedAnalysis,
      },
    ]);
    assert.match(report, /VARIED\s+lemonade \/ wiki-navigation/);
    assert.match(report, /flaky-target\s+P F/);
    assert.doesNotMatch(report, /stable\s+P P/);
    assert.match(report, /Overall: VARIED/);
  });

  it('attributes variance in non-judge scenarios to the model or server [unit]', () => {
    const report = formatProbeReport([
      { suiteId: 's', model: 'm', status: 'analyzed', analysis: variedAnalysis },
    ]);
    assert.match(report, /do not use the judge/);
    assert.doesNotMatch(report, /judge-dependent: they can vary/);
  });

  it('notes the unseedable Claude judge when a judge-dependent scenario varied [unit]', () => {
    const judged = analyzeDeterminism(
      probeRuns(
        [
          makeResult('j', true, {
            type: 'tool-call',
            expectedTool: 't',
            toolCalled: 't',
            fieldResults: [],
            score: 1,
            responseJudge: judgeDetails,
          }),
        ],
        [
          makeResult('j', false, {
            type: 'tool-call',
            expectedTool: 't',
            toolCalled: 't',
            fieldResults: [],
            score: 0,
            responseJudge: judgeDetails,
          }),
        ],
      ),
    );
    const report = formatProbeReport([
      { suiteId: 's', model: 'm', status: 'analyzed', analysis: judged },
    ]);
    assert.match(report, /judge-dependent/);
    assert.match(report, /Anthropic has no seed parameter/);
  });

  it('reports a clean run as identical with no hints [unit]', () => {
    const clean = analyzeDeterminism(probeRuns([makeResult('a', true)], [makeResult('a', true)]));
    const report = formatProbeReport([
      { suiteId: 's', model: 'm', status: 'analyzed', analysis: clean },
    ]);
    assert.match(report, /IDENTICAL\s+m \/ s/);
    assert.match(report, /Overall: IDENTICAL/);
    assert.doesNotMatch(report, /do not use the judge/);
  });

  it('never presents an aborted probe as an identical result [unit]', () => {
    const report = formatProbeReport([], { aborted: true });
    assert.match(report, /Overall: ABORTED/);
    assert.doesNotMatch(report, /Overall: IDENTICAL/);
  });

  it('shows errored pairs with their reason and calls the probe incomplete [unit]', () => {
    const report = formatProbeReport([
      { suiteId: 's', model: 'm', status: 'errored', reason: 'exit code 3' },
    ]);
    assert.match(report, /ERRORED\s+m \/ s — exit code 3/);
    assert.match(report, /Overall: INCOMPLETE/);
  });
});
