import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { describe, it } from 'mocha';
import { writeResultYaml, readResultYaml, writeReviewManifest, readReviewManifest } from '../../src/serializer.js';
import type { EvalRun, ScenarioResult, Suite } from '../../src/schemas.js';

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
    actualOutput: 'output text here',
    latencyMs: 100,
    estimatedCostUsd: 0.001,
    details: { type: 'deterministic', match: 'contains', expected: 'output', passed: true },
    ...overrides,
  };
}

const MOCK_SUITE: Suite = {
  suite: { id: 'test-suite', name: 'Test Suite', purpose: 'Testing' },
  scenarios: [
    {
      id: 'sc-1', name: 'Scenario 1', purpose: 'p', input: 'i',
      type: 'deterministic', match: 'contains', expected: 'output',
    },
  ],
};

describe('writeResultYaml + readResultYaml', () => {
  it('writes a file and reads it back with matching run data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-serial-test-'));
    try {
      const run = makeRun();
      const result = makeResult(run.id);
      const filePath = await writeResultYaml(run, [result], dir);

      assert.ok(existsSync(filePath), 'YAML file should exist');
      assert.ok(filePath.endsWith('.yaml'));

      const { run: parsedRun, results: parsedResults } = await readResultYaml(filePath);
      assert.equal(parsedRun.id, run.id);
      assert.equal(parsedRun.suiteId, run.suiteId);
      assert.equal(parsedRun.model, run.model);
      assert.equal(parsedResults.length, 1);
      assert.equal(parsedResults[0]?.scenarioId, 'sc-1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates resultPath directory if it does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-serial-test-'));
    const nested = join(dir, 'nested', 'path');
    try {
      const run = makeRun();
      await writeResultYaml(run, [makeResult(run.id)], nested);
      assert.ok(existsSync(nested));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('roundtrips LLM judge details correctly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-serial-judge-'));
    try {
      const run = makeRun();
      const result = makeResult(run.id, {
        details: {
          type: 'llm-judge',
          score: 8,
          reasoning: 'This was a well-reasoned response.',
          judgeModel: 'claude-haiku',
          biasRisk: false,
        },
      });
      const filePath = await writeResultYaml(run, [result], dir);
      const { results } = await readResultYaml(filePath);
      assert.equal(results[0]?.details.type, 'llm-judge');
      if (results[0]?.details.type === 'llm-judge') {
        assert.equal(results[0].details.score, 8);
        assert.equal(results[0].details.reasoning, 'This was a well-reasoned response.');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writeReviewManifest + readReviewManifest', () => {
  it('writes a manifest and reads it back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-manifest-test-'));
    try {
      const run = makeRun();
      const humanSuite: Suite = {
        suite: { id: 'test-suite', name: 'Test Suite', purpose: 'Testing' },
        scenarios: [
          {
            id: 'h-1', name: 'Human 1', purpose: 'p', input: 'test input',
            type: 'human', rubric: 'test rubric',
            scoring: { type: 'choice', options: [{ key: 'y', label: 'Yes', pass: true }, { key: 'n', label: 'No', pass: false }] },
            status: 'pending',
          },
        ],
      };
      const pendingResult = makeResult(run.id, {
        scenarioId: 'h-1',
        passed: false,
        score: null,
        details: { type: 'human', status: 'pending' },
      });

      const suites = new Map([['test-suite', humanSuite]]);
      const manifestPath = await writeReviewManifest(run, [pendingResult], suites, dir);

      assert.ok(existsSync(manifestPath));
      const manifest = await readReviewManifest(manifestPath);
      assert.equal(manifest.runId, run.id);
      assert.equal(manifest.reviews.length, 1);
      assert.equal(manifest.reviews[0]?.scenarioId, 'h-1');
      assert.equal(manifest.reviews[0]?.input, 'test input');
      assert.equal(manifest.reviews[0]?.rubric, 'test rubric');
      assert.equal(manifest.reviews[0]?.response, '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
