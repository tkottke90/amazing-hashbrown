import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { compareRuns } from '../../src/comparator.js';
import type { EvalRun, ScenarioResult } from '../../src/schemas.js';

function makeRun(id: string, model = 'model-a'): EvalRun {
  return {
    id,
    suiteId: 'test-suite',
    model,
    startedAt: new Date().toISOString(),
    passed: true,
    passRate: 1,
    totalScenarios: 1,
    passedScenarios: 1,
    totalLatencyMs: 100,
    estimatedCostUsd: 0.001,
  };
}

function makeResult(runId: string, scenarioId: string, passed: boolean): ScenarioResult {
  return {
    id: crypto.randomUUID(),
    runId,
    scenarioId,
    suiteId: 'test-suite',
    passed,
    score: passed ? 1 : 0,
    actualOutput: 'output',
    latencyMs: 100,
    estimatedCostUsd: 0.001,
    details: { type: 'deterministic', match: 'contains', expected: 'x', passed },
  };
}

function makeHumanResult(runId: string, scenarioId: string, status: 'pending' | 'approved' | 'rejected'): ScenarioResult {
  return {
    id: crypto.randomUUID(),
    runId,
    scenarioId,
    suiteId: 'test-suite',
    passed: status === 'approved',
    score: status === 'approved' ? 1 : null,
    actualOutput: 'output',
    latencyMs: 50,
    estimatedCostUsd: 0,
    details: { type: 'human', status },
  };
}

describe('compareRuns', () => {
  describe('change classification', () => {
    it('classifies pass→pass correctly', () => {
      const runA = makeRun('run-a');
      const runB = makeRun('run-b', 'model-b');
      const cmp = compareRuns(runA, [makeResult('run-a', 'sc-1', true)], runB, [makeResult('run-b', 'sc-1', true)]);
      const sc = cmp.scenarios.find((s) => s.scenarioId === 'sc-1');
      assert.equal(sc?.change, 'pass→pass');
    });

    it('classifies fail→fail correctly', () => {
      const runA = makeRun('run-a');
      const runB = makeRun('run-b');
      const cmp = compareRuns(runA, [makeResult('run-a', 'sc-1', false)], runB, [makeResult('run-b', 'sc-1', false)]);
      assert.equal(cmp.scenarios[0]?.change, 'fail→fail');
    });

    it('classifies fail→pass (improvement) correctly', () => {
      const runA = makeRun('run-a');
      const runB = makeRun('run-b');
      const cmp = compareRuns(runA, [makeResult('run-a', 'sc-1', false)], runB, [makeResult('run-b', 'sc-1', true)]);
      assert.equal(cmp.scenarios[0]?.change, 'fail→pass');
    });

    it('classifies pass→fail (regression) correctly', () => {
      const runA = makeRun('run-a');
      const runB = makeRun('run-b');
      const cmp = compareRuns(runA, [makeResult('run-a', 'sc-1', true)], runB, [makeResult('run-b', 'sc-1', false)]);
      assert.equal(cmp.scenarios[0]?.change, 'pass→fail');
    });

    it('classifies added scenarios', () => {
      const runA = makeRun('run-a');
      const runB = makeRun('run-b');
      const cmp = compareRuns(runA, [], runB, [makeResult('run-b', 'sc-new', true)]);
      assert.equal(cmp.scenarios[0]?.change, 'added');
      assert.equal(cmp.scenarios[0]?.runA, null);
    });

    it('classifies removed scenarios', () => {
      const runA = makeRun('run-a');
      const runB = makeRun('run-b');
      const cmp = compareRuns(runA, [makeResult('run-a', 'sc-old', true)], runB, []);
      assert.equal(cmp.scenarios[0]?.change, 'removed');
      assert.equal(cmp.scenarios[0]?.runB, null);
    });

    it('classifies pending human scenarios as pending', () => {
      const runA = makeRun('run-a');
      const runB = makeRun('run-b');
      const cmp = compareRuns(
        runA, [makeHumanResult('run-a', 'h-1', 'pending')],
        runB, [makeHumanResult('run-b', 'h-1', 'approved')],
      );
      assert.equal(cmp.scenarios[0]?.change, 'pending');
    });
  });

  describe('summary counts', () => {
    it('counts improved and regressed correctly', () => {
      const runA = makeRun('run-a');
      const runB = makeRun('run-b');
      const cmp = compareRuns(
        runA,
        [makeResult('run-a', 'sc-1', false), makeResult('run-a', 'sc-2', true)],
        runB,
        [makeResult('run-b', 'sc-1', true), makeResult('run-b', 'sc-2', false)],
      );
      assert.equal(cmp.summary.improved, 1);
      assert.equal(cmp.summary.regressed, 1);
      assert.equal(cmp.summary.unchanged, 0);
    });

    it('counts added and removed', () => {
      const runA = makeRun('run-a');
      const runB = makeRun('run-b');
      const cmp = compareRuns(
        runA,
        [makeResult('run-a', 'sc-old', true)],
        runB,
        [makeResult('run-b', 'sc-new', true)],
      );
      assert.equal(cmp.summary.added, 1);
      assert.equal(cmp.summary.removed, 1);
      assert.equal(cmp.summary.unchanged, 0);
    });
  });

  describe('output shape', () => {
    it('includes suiteId, runA, runB in result', () => {
      const runA = makeRun('run-a');
      const runB = makeRun('run-b');
      const cmp = compareRuns(runA, [], runB, []);
      assert.equal(cmp.suiteId, 'test-suite');
      assert.deepEqual(cmp.runA, runA);
      assert.deepEqual(cmp.runB, runB);
    });
  });
});
