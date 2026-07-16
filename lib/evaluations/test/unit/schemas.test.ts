import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import {
  ScenarioSchema,
  HumanScenarioSchema,
  SemanticScenarioSchema,
  SuiteSchema,
  JsonOf,
  ScenarioResultDetailsSchema,
} from '../../src/schemas.js';
import { z } from 'zod';

describe('ScenarioSchema', () => {
  it('parses deterministic scenario', () => {
    const result = ScenarioSchema.parse({
      id: 'test-1',
      name: 'Test',
      purpose: 'Purpose',
      input: 'Input',
      type: 'deterministic',
      match: 'contains',
      expected: 'expected value',
    });
    assert.equal(result.type, 'deterministic');
  });

  it('parses semantic scenario with defaults', () => {
    const result = ScenarioSchema.parse({
      id: 'test-2',
      name: 'Test',
      purpose: 'Purpose',
      input: 'Input',
      type: 'semantic',
      expectedSimilarTo: 'some text',
    });
    assert.equal(result.type, 'semantic');
    if (result.type === 'semantic') {
      assert.equal(result.minSimilarity, 0.75);
    }
  });

  it('parses llm-judge scenario with defaults', () => {
    const result = ScenarioSchema.parse({
      id: 'test-3',
      name: 'Test',
      purpose: 'Purpose',
      input: 'Input',
      type: 'llm-judge',
      rubric: 'A rubric',
    });
    assert.equal(result.type, 'llm-judge');
    if (result.type === 'llm-judge') {
      assert.equal(result.minScore, 7);
    }
  });

  it('parses human scenario with defaults', () => {
    const result = ScenarioSchema.parse({
      id: 'test-4',
      name: 'Test',
      purpose: 'Purpose',
      input: 'Input',
      type: 'human',
      rubric: 'A rubric',
      scoring: {
        type: 'choice',
        options: [
          { key: 'y', label: 'Yes', pass: true },
          { key: 'n', label: 'No', pass: false },
        ],
      },
    });
    assert.equal(result.type, 'human');
    if (result.type === 'human') {
      assert.equal(result.status, 'pending');
    }
  });

  it('throws on unknown type', () => {
    assert.throws(() => {
      ScenarioSchema.parse({ id: 'x', name: 'x', purpose: 'x', input: 'x', type: 'unknown' });
    });
  });
});

describe('SemanticScenarioSchema', () => {
  it('defaults minSimilarity to 0.75', () => {
    const result = SemanticScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      input: 'x',
      type: 'semantic',
      expectedSimilarTo: 'text',
    });
    assert.equal(result.minSimilarity, 0.75);
  });

  it('accepts custom minSimilarity', () => {
    const result = SemanticScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      input: 'x',
      type: 'semantic',
      expectedSimilarTo: 'text',
      minSimilarity: 0.9,
    });
    assert.equal(result.minSimilarity, 0.9);
  });
});

describe('HumanScenarioSchema', () => {
  it('defaults status to pending', () => {
    const result = HumanScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      input: 'x',
      type: 'human',
      rubric: 'r',
      scoring: {
        type: 'choice',
        options: [
          { key: 'y', label: 'Yes', pass: true },
          { key: 'n', label: 'No', pass: false },
        ],
      },
    });
    assert.equal(result.status, 'pending');
  });

  it('accepts scale scoring', () => {
    const result = HumanScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      input: 'x',
      type: 'human',
      rubric: 'r',
      scoring: {
        type: 'scale',
        options: [
          { value: 1, label: 'Bad' },
          { value: 2, label: 'Good' },
        ],
        passingScore: 2,
      },
    });
    assert.equal(result.scoring.type, 'scale');
  });
});

describe('SuiteSchema', () => {
  it('parses a valid suite', () => {
    const result = SuiteSchema.parse({
      suite: { id: 's1', name: 'Suite 1', purpose: 'Purpose' },
      scenarios: [
        {
          id: 'sc1',
          name: 'SC1',
          purpose: 'P',
          input: 'I',
          type: 'deterministic',
          match: 'contains',
          expected: 'e',
        },
      ],
    });
    assert.equal(result.suite.id, 's1');
    assert.equal(result.scenarios.length, 1);
  });

  it('throws when scenarios is empty', () => {
    assert.throws(() =>
      SuiteSchema.parse({
        suite: { id: 's1', name: 'Suite 1', purpose: 'Purpose' },
        scenarios: [],
      }),
    );
  });
});

describe('JsonOf helper', () => {
  const schema = JsonOf(z.object({ score: z.number() }));

  it('parses valid JSON', () => {
    const result = schema.parse('{"score": 7}');
    assert.deepEqual(result, { score: 7 });
  });

  it('throws on invalid JSON', () => {
    assert.throws(() => schema.parse('not-json'));
  });

  it('throws on JSON that fails the inner schema', () => {
    assert.throws(() => schema.parse('{"score": "seven"}'));
  });

  it('parses ScenarioResultDetailsSchema via JsonOf', () => {
    const detailsSchema = JsonOf(ScenarioResultDetailsSchema);
    const result = detailsSchema.parse(
      JSON.stringify({
        type: 'deterministic',
        match: 'contains',
        expected: 'e',
        passed: true,
      }),
    );
    assert.equal(result.type, 'deterministic');
  });
});
