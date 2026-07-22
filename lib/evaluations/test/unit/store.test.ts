import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { EvaluationsStore, type HumanResultUpdate } from '../../src/store.js';
import type { EvalRun, ScenarioResult } from '../../src/schemas.js';

function makeRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    id: crypto.randomUUID(),
    suiteId: 'test-suite',
    model: 'test-model',
    startedAt: new Date().toISOString(),
    passed: true,
    passRate: 1,
    totalScenarios: 1,
    passedScenarios: 1,
    totalLatencyMs: 100,
    estimatedCostUsd: 0.001,
    ...overrides,
  };
}

function makeResult(runId: string, overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    id: crypto.randomUUID(),
    runId,
    scenarioId: 'sc-1',
    suiteId: 'test-suite',
    passed: true,
    score: 1,
    actualOutput: 'output text',
    latencyMs: 100,
    estimatedCostUsd: 0.001,
    details: { type: 'deterministic', match: 'contains', expected: 'output', passed: true },
    ...overrides,
  };
}

describe('EvaluationsStore', () => {
  let tmpDir: string;
  let store: EvaluationsStore;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'eval-store-test-'));
    const db = openDatabase(join(tmpDir, 'test.db'));
    store = new EvaluationsStore(db);
  });

  after(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('saveRun + findRunById', () => {
    it('saves a run and retrieves it by id', () => {
      const run = makeRun();
      const result = makeResult(run.id);
      store.saveRun(run, [result]);

      const found = store.findRunById(run.id);
      assert.ok(found);
      assert.equal(found.id, run.id);
      assert.equal(found.suiteId, run.suiteId);
      assert.equal(found.model, run.model);
      assert.equal(found.passed, true);
      assert.equal(found.passRate, 1);
    });

    it('returns null for unknown run id', () => {
      const found = store.findRunById('does-not-exist');
      assert.equal(found, null);
    });
  });

  describe('findResultsByRunId', () => {
    it('returns all results for a run', () => {
      const run = makeRun();
      const r1 = makeResult(run.id, { scenarioId: 'sc-a' });
      const r2 = makeResult(run.id, { scenarioId: 'sc-b' });
      store.saveRun(run, [r1, r2]);

      const results = store.findResultsByRunId(run.id);
      assert.equal(results.length, 2);
      assert.ok(results.some((r) => r.scenarioId === 'sc-a'));
      assert.ok(results.some((r) => r.scenarioId === 'sc-b'));
    });

    it('parses details JSON back to typed object', () => {
      const run = makeRun();
      const result = makeResult(run.id, {
        details: {
          type: 'llm-judge',
          score: 8,
          reasoning: 'Good',
          judgeModel: 'gpt-4',
          biasRisk: false,
        },
      });
      store.saveRun(run, [result]);

      const [found] = store.findResultsByRunId(run.id);
      assert.equal(found?.details.type, 'llm-judge');
      if (found?.details.type === 'llm-judge') {
        assert.equal(found.details.score, 8);
        assert.equal(found.details.reasoning, 'Good');
      }
    });
  });

  describe('findRuns', () => {
    it('filters by suiteId', () => {
      const run1 = makeRun({ suiteId: 'suite-alpha' });
      const run2 = makeRun({ suiteId: 'suite-beta' });
      store.saveRun(run1, [makeResult(run1.id)]);
      store.saveRun(run2, [makeResult(run2.id)]);

      const results = store.findRuns({ suiteId: 'suite-alpha' });
      assert.ok(results.every((r) => r.suiteId === 'suite-alpha'));
      assert.ok(results.some((r) => r.id === run1.id));
    });

    it('filters by model', () => {
      const run = makeRun({ model: 'unique-model-xyz' });
      store.saveRun(run, [makeResult(run.id)]);

      const results = store.findRuns({ model: 'unique-model-xyz' });
      assert.ok(results.length >= 1);
      assert.ok(results.every((r) => r.model === 'unique-model-xyz'));
    });

    it('filters by since', () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const run = makeRun({ startedAt: new Date().toISOString() });
      store.saveRun(run, [makeResult(run.id)]);

      const results = store.findRuns({ since: past });
      assert.ok(results.some((r) => r.id === run.id));
    });

    it('respects limit and offset', () => {
      Array.from({ length: 3 }, () => {
        const r = makeRun({ suiteId: 'paging-suite' });
        store.saveRun(r, [makeResult(r.id)]);
        return r;
      });

      const page1 = store.findRuns({ suiteId: 'paging-suite', limit: 2, offset: 0 });
      const page2 = store.findRuns({ suiteId: 'paging-suite', limit: 2, offset: 2 });
      assert.equal(page1.length, 2);
      assert.equal(page2.length, 1);
    });
  });

  describe('findPendingHumanResults', () => {
    it('returns only human results with pending status', () => {
      const run = makeRun();
      const pending = makeResult(run.id, {
        scenarioId: 'human-pending',
        passed: false,
        score: null,
        details: { type: 'human', status: 'pending' },
      });
      const skipped = makeResult(run.id, {
        scenarioId: 'human-skipped',
        passed: false,
        score: null,
        details: { type: 'human', status: 'skipped' },
      });
      const approved = makeResult(run.id, {
        scenarioId: 'human-approved',
        passed: true,
        score: 1,
        details: { type: 'human', status: 'approved', response: 'y' },
      });
      const det = makeResult(run.id, {
        scenarioId: 'auto-det',
      });
      store.saveRun(run, [pending, skipped, approved, det]);

      const found = store.findPendingHumanResults(run.id);
      assert.equal(found.length, 1);
      assert.equal(found[0]?.scenarioId, 'human-pending');
    });
  });

  describe('updateHumanResult', () => {
    it('updates status, response, and notes on a human result', () => {
      const run = makeRun();
      const result = makeResult(run.id, {
        passed: false,
        score: null,
        details: { type: 'human', status: 'pending' },
      });
      store.saveRun(run, [result]);

      const update: HumanResultUpdate = {
        status: 'approved',
        response: 'y',
        reviewerNotes: 'Looks good',
      };
      store.updateHumanResult(result.id, update);

      const [updated] = store.findResultsByRunId(run.id);
      assert.equal(updated?.details.type, 'human');
      if (updated?.details.type === 'human') {
        assert.equal(updated.details.status, 'approved');
        assert.equal(updated.details.response, 'y');
        assert.equal(updated.details.reviewerNotes, 'Looks good');
      }
    });
  });

  describe('judge calibration', () => {
    function makeJudgeResult(runId: string, overrides: Partial<ScenarioResult> = {}) {
      return makeResult(runId, {
        scenarioId: 'judge-sc',
        details: {
          type: 'llm-judge',
          score: 8,
          reasoning: 'Handles the edge case correctly',
          judgeModel: 'test-judge-model',
          biasRisk: false,
        },
        ...overrides,
      });
    }

    describe('findJudgeResultsForRun', () => {
      it('returns only llm-judge results for the run', () => {
        const run = makeRun();
        const judgeResult = makeJudgeResult(run.id);
        const det = makeResult(run.id, { scenarioId: 'det-sc' });
        store.saveRun(run, [judgeResult, det]);

        const found = store.findJudgeResultsForRun(run.id);
        assert.equal(found.length, 1);
        assert.equal(found[0]?.scenarioId, 'judge-sc');
        assert.equal(found[0]?.details.type, 'llm-judge');
      });

      it('does not return llm-judge results from a different run', () => {
        const run1 = makeRun();
        const run2 = makeRun();
        store.saveRun(run1, [makeJudgeResult(run1.id)]);
        store.saveRun(run2, [makeJudgeResult(run2.id)]);

        const found = store.findJudgeResultsForRun(run1.id);
        assert.equal(found.length, 1);
        assert.equal(found[0]?.runId, run1.id);
      });
    });

    describe('recordJudgeCalibration + getCalibrationSummary', () => {
      it('computes agreement when the human verdict matches the judge', () => {
        const run = makeRun();
        const result = makeJudgeResult(run.id, { passed: true });
        store.saveRun(run, [result]);

        store.recordJudgeCalibration({
          id: crypto.randomUUID(),
          resultId: result.id,
          judgeScore: 8,
          judgePassed: true,
          humanPassed: true,
          gradedAt: new Date().toISOString(),
        });

        const summary = store.getCalibrationSummary(run.id);
        assert.equal(summary.total, 1);
        assert.equal(summary.agreeCount, 1);
        assert.equal(summary.agreementRate, 1);
        assert.equal(summary.disagreements.length, 0);
      });

      it('lists a disagreement, with scenarioId and reviewer notes, when verdicts differ', () => {
        const run = makeRun();
        const result = makeJudgeResult(run.id, { passed: true });
        store.saveRun(run, [result]);

        store.recordJudgeCalibration({
          id: crypto.randomUUID(),
          resultId: result.id,
          judgeScore: 8,
          judgePassed: true,
          humanPassed: false,
          reviewerNotes: 'Missed a hallucinated claim',
          gradedAt: new Date().toISOString(),
        });

        const summary = store.getCalibrationSummary(run.id);
        assert.equal(summary.total, 1);
        assert.equal(summary.agreeCount, 0);
        assert.equal(summary.agreementRate, 0);
        assert.equal(summary.disagreements.length, 1);
        assert.equal(summary.disagreements[0]?.scenarioId, 'judge-sc');
        assert.equal(summary.disagreements[0]?.reviewerNotes, 'Missed a hallucinated claim');
      });

      it('returns a zeroed summary for a run with no calibrations', () => {
        const run = makeRun();
        store.saveRun(run, [makeJudgeResult(run.id)]);

        const summary = store.getCalibrationSummary(run.id);
        assert.equal(summary.total, 0);
        assert.equal(summary.agreeCount, 0);
        assert.equal(summary.agreementRate, 0);
        assert.deepEqual(summary.disagreements, []);
      });

      it('aggregates agreement rate across multiple calibrations for the same run', () => {
        const run = makeRun();
        const r1 = makeJudgeResult(run.id, { scenarioId: 'judge-sc-1' });
        const r2 = makeJudgeResult(run.id, { scenarioId: 'judge-sc-2' });
        store.saveRun(run, [r1, r2]);

        store.recordJudgeCalibration({
          id: crypto.randomUUID(),
          resultId: r1.id,
          judgeScore: 8,
          judgePassed: true,
          humanPassed: true,
          gradedAt: new Date().toISOString(),
        });
        store.recordJudgeCalibration({
          id: crypto.randomUUID(),
          resultId: r2.id,
          judgeScore: 3,
          judgePassed: false,
          humanPassed: true,
          gradedAt: new Date().toISOString(),
        });

        const summary = store.getCalibrationSummary(run.id);
        assert.equal(summary.total, 2);
        assert.equal(summary.agreeCount, 1);
        assert.equal(summary.agreementRate, 0.5);
        assert.equal(summary.disagreements.length, 1);
      });
    });
  });
});

describe('EvaluationsStore migration versioning', () => {
  it('records versions 3 and 4 in schema_migrations', () => {
    const tmpDir2 = mkdtempSync(join(tmpdir(), 'eval-migration-test-'));
    try {
      const db = openDatabase(join(tmpDir2, 'shared.db'));
      const evalStore = new EvaluationsStore(db);

      const versions = (
        db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>
      ).map((r) => r.version);
      assert.ok(
        versions.includes(3),
        `Expected version 3 in migrations, got: ${JSON.stringify(versions)}`,
      );
      assert.ok(
        versions.includes(4),
        `Expected version 4 in migrations, got: ${JSON.stringify(versions)}`,
      );

      evalStore.close();
    } finally {
      rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  it('creates eval_runs, eval_results, and judge_calibrations tables', () => {
    const tmpDir2 = mkdtempSync(join(tmpdir(), 'eval-tables-test-'));
    try {
      const db = openDatabase(join(tmpDir2, 'tables.db'));
      const evalStore = new EvaluationsStore(db);

      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name);
      assert.ok(tables.includes('eval_runs'), `eval_runs not found in: ${JSON.stringify(tables)}`);
      assert.ok(
        tables.includes('eval_results'),
        `eval_results not found in: ${JSON.stringify(tables)}`,
      );
      assert.ok(
        tables.includes('judge_calibrations'),
        `judge_calibrations not found in: ${JSON.stringify(tables)}`,
      );

      evalStore.close();
    } finally {
      rmSync(tmpDir2, { recursive: true, force: true });
    }
  });
});
