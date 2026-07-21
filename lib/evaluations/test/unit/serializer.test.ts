import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { describe, it } from 'mocha';
import { readFileSync } from 'node:fs';
import {
  writeResultYaml,
  readResultYaml,
  writeReviewManifest,
  readReviewManifest,
  writeResultHtml,
} from '../../src/serializer.js';
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

describe('writeResultHtml', () => {
  function makeSuite(scenarios: Suite['scenarios']): Suite {
    return {
      suite: { id: 'test-suite', name: 'Test Suite', purpose: 'Testing' },
      scenarios,
    };
  }

  it('writes an HTML file containing the scenario name, purpose, and input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-html-test-'));
    try {
      const run = makeRun();
      const suite = makeSuite([
        {
          id: 'sc-1',
          name: 'My Scenario Name',
          purpose: 'Verifies a thing.',
          input: 'the scenario input text',
          type: 'deterministic',
          match: 'contains',
          expected: 'output',
        },
      ]);
      const filePath = await writeResultHtml(run, [makeResult(run.id)], suite, dir);
      assert.ok(existsSync(filePath));
      assert.ok(filePath.endsWith('.html'));

      const html = readFileSync(filePath, 'utf-8');
      assert.ok(html.includes('My Scenario Name'));
      assert.ok(html.includes('Verifies a thing.'));
      assert.ok(html.includes('the scenario input text'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formats latency in ms below 1s, seconds below 1min, and minutes beyond that', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-html-duration-'));
    try {
      const run = makeRun();
      const suite = makeSuite([
        {
          id: 'sc-ms',
          name: 'Ms scenario',
          purpose: 'p',
          input: 'i',
          type: 'deterministic',
          match: 'contains',
          expected: 'e',
        },
        {
          id: 'sc-s',
          name: 'Sec scenario',
          purpose: 'p',
          input: 'i',
          type: 'deterministic',
          match: 'contains',
          expected: 'e',
        },
        {
          id: 'sc-m',
          name: 'Min scenario',
          purpose: 'p',
          input: 'i',
          type: 'deterministic',
          match: 'contains',
          expected: 'e',
        },
      ]);
      const results = [
        makeResult(run.id, { scenarioId: 'sc-ms', latencyMs: 842 }),
        makeResult(run.id, { scenarioId: 'sc-s', latencyMs: 2300 }),
        makeResult(run.id, { scenarioId: 'sc-m', latencyMs: 90000 }),
      ];
      const filePath = await writeResultHtml(run, results, suite, dir);
      const html = readFileSync(filePath, 'utf-8');
      assert.ok(html.includes('842ms'));
      assert.ok(html.includes('2.3s'));
      assert.ok(html.includes('1m 30s'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders a field-check table for structured scenario details', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-html-structured-'));
    try {
      const run = makeRun();
      const suite = makeSuite([
        {
          id: 'sc-struct',
          name: 'Structured scenario',
          purpose: 'p',
          input: 'i',
          type: 'structured',
          outputSchema: {},
          fieldChecks: [{ path: 'shouldWrite', match: 'equals', value: true }],
        },
      ]);
      const result = makeResult(run.id, {
        scenarioId: 'sc-struct',
        details: {
          type: 'structured',
          score: 1,
          fieldResults: [
            { path: 'shouldWrite', match: 'equals', expected: true, actual: true, passed: true },
          ],
        },
      });
      const filePath = await writeResultHtml(run, [result], suite, dir);
      const html = readFileSync(filePath, 'utf-8');
      assert.ok(html.includes('field-check-table'));
      assert.ok(html.includes('shouldWrite'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shows a malformed-tool-call warning when no tool was called but invalidToolCalls is present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-html-invalid-tool-'));
    try {
      const run = makeRun();
      const suite = makeSuite([
        {
          id: 'sc-tc',
          name: 'Tool call scenario',
          purpose: 'p',
          input: 'i',
          type: 'tool-call',
          tool: 'wiki_search',
        },
      ]);
      const result = makeResult(run.id, {
        scenarioId: 'sc-tc',
        passed: false,
        details: {
          type: 'tool-call',
          expectedTool: 'wiki_search',
          toolCalled: null,
          fieldResults: [],
          score: 0,
          invalidToolCalls: [
            { name: 'wiki_search', args: '{bad json', error: 'failed to parse arguments' },
          ],
        },
      });
      const filePath = await writeResultHtml(run, [result], suite, dir);
      const html = readFileSync(filePath, 'utf-8');
      assert.ok(html.includes('malformed tool call'));
      assert.ok(html.includes('failed to parse arguments'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shows response metadata when no tool was called and no invalidToolCalls exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-html-response-metadata-'));
    try {
      const run = makeRun();
      const suite = makeSuite([
        {
          id: 'sc-tc',
          name: 'Tool call scenario',
          purpose: 'p',
          input: 'i',
          type: 'tool-call',
          tool: 'wiki_search',
        },
      ]);
      const result = makeResult(run.id, {
        scenarioId: 'sc-tc',
        passed: false,
        details: {
          type: 'tool-call',
          expectedTool: 'wiki_search',
          toolCalled: null,
          fieldResults: [],
          score: 0,
          responseMetadata: { done_reason: 'stop' },
        },
      });
      const filePath = await writeResultHtml(run, [result], suite, dir);
      const html = readFileSync(filePath, 'utf-8');
      assert.ok(html.includes('response metadata'));
      assert.ok(html.includes('done_reason'));
      assert.ok(html.includes('stop'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks every scenario row as clickable/expandable, not just failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-html-expand-'));
    try {
      const run = makeRun();
      const suite = makeSuite([
        {
          id: 'sc-1',
          name: 'Passing scenario',
          purpose: 'p',
          input: 'i',
          type: 'deterministic',
          match: 'contains',
          expected: 'e',
        },
      ]);
      const result = makeResult(run.id, { scenarioId: 'sc-1', passed: true });
      const filePath = await writeResultHtml(run, [result], suite, dir);
      const html = readFileSync(filePath, 'utf-8');
      assert.ok(html.includes('scenario-row'));
      assert.ok(html.includes(`data-target="detail-${result.id}"`));
      assert.ok(html.includes(`id="detail-${result.id}"`));
      assert.ok(html.includes('hidden'));
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
            id: 'h-1',
            name: 'Human 1',
            purpose: 'p',
            input: 'test input',
            type: 'human',
            rubric: 'test rubric',
            scoring: {
              type: 'choice',
              options: [
                { key: 'y', label: 'Yes', pass: true },
                { key: 'n', label: 'No', pass: false },
              ],
            },
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
