import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import {
  ScenarioSchema,
  HumanScenarioSchema,
  LlmJudgeScenarioSchema,
  SemanticScenarioSchema,
  StructuredScenarioSchema,
  ToolCallScenarioSchema,
  ToolSequenceScenarioSchema,
  SuiteSchema,
  EvalRunSchema,
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

  it('defaults skip to undefined', () => {
    const result = ScenarioSchema.parse({
      id: 'test-skip-default',
      name: 'Test',
      purpose: 'Purpose',
      input: 'Input',
      type: 'deterministic',
      match: 'contains',
      expected: 'expected value',
    });
    assert.equal(result.skip, undefined);
  });

  it('accepts skip: true on any scenario type', () => {
    const result = ScenarioSchema.parse({
      id: 'test-skip-true',
      name: 'Test',
      purpose: 'Purpose',
      input: 'Input',
      type: 'deterministic',
      match: 'contains',
      expected: 'expected value',
      skip: true,
    });
    assert.equal(result.skip, true);
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

  it('parses structured scenario with defaults', () => {
    const result = ScenarioSchema.parse({
      id: 'test-5',
      name: 'Test',
      purpose: 'Purpose',
      input: 'Input',
      type: 'structured',
      outputSchema: { type: 'object', properties: { shouldWrite: { type: 'boolean' } } },
      fieldChecks: [{ path: 'shouldWrite', match: 'equals', value: true }],
    });
    assert.equal(result.type, 'structured');
    if (result.type === 'structured') {
      assert.equal(result.minScore, 1);
    }
  });

  it('parses tool-call scenario with defaults', () => {
    const result = ScenarioSchema.parse({
      id: 'test-6',
      name: 'Test',
      purpose: 'Purpose',
      input: 'Input',
      type: 'tool-call',
      tool: 'upload_image',
    });
    assert.equal(result.type, 'tool-call');
    if (result.type === 'tool-call') {
      assert.equal(result.minScore, 1);
      assert.equal(result.argChecks, undefined);
    }
  });

  it('parses tool-sequence scenario with defaults', () => {
    const result = ScenarioSchema.parse({
      id: 'test-7',
      name: 'Test',
      purpose: 'Purpose',
      input: 'Input',
      type: 'tool-sequence',
      priorTurns: [{ tool: 'generate_image', result: { imageBase64: 'abc' } }],
      tool: 'upload_image',
    });
    assert.equal(result.type, 'tool-sequence');
    if (result.type === 'tool-sequence') {
      assert.equal(result.minScore, 1);
      assert.deepEqual(result.priorTurns[0].args, {});
    }
  });

  it('throws on unknown type', () => {
    assert.throws(() => {
      ScenarioSchema.parse({ id: 'x', name: 'x', purpose: 'x', input: 'x', type: 'unknown' });
    });
  });
});

describe('StructuredScenarioSchema', () => {
  it('defaults minScore to 1', () => {
    const result = StructuredScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      input: 'x',
      type: 'structured',
      outputSchema: {},
      fieldChecks: [{ path: 'a', match: 'exists' }],
    });
    assert.equal(result.minScore, 1);
  });

  it('accepts custom minScore', () => {
    const result = StructuredScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      input: 'x',
      type: 'structured',
      outputSchema: {},
      fieldChecks: [{ path: 'a', match: 'exists' }],
      minScore: 0.5,
    });
    assert.equal(result.minScore, 0.5);
  });

  it('accepts the oneOf match type with an array value', () => {
    const result = StructuredScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      input: 'x',
      type: 'structured',
      outputSchema: {},
      fieldChecks: [{ path: 'type', match: 'oneOf', value: ['entity', 'concept'] }],
    });
    assert.equal(result.fieldChecks[0].match, 'oneOf');
  });

  it('throws when fieldChecks is empty', () => {
    assert.throws(() =>
      StructuredScenarioSchema.parse({
        id: 'x',
        name: 'x',
        purpose: 'x',
        input: 'x',
        type: 'structured',
        outputSchema: {},
        fieldChecks: [],
      }),
    );
  });
});

describe('ToolCallScenarioSchema', () => {
  it('defaults minScore to 1 and allows argChecks to be omitted', () => {
    const result = ToolCallScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      input: 'x',
      type: 'tool-call',
      tool: 'upload_image',
    });
    assert.equal(result.minScore, 1);
    assert.equal(result.argChecks, undefined);
  });

  it('accepts argChecks using the same shape as structured fieldChecks', () => {
    const result = ToolCallScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      input: 'x',
      type: 'tool-call',
      tool: 'upload_image',
      argChecks: [{ path: 'mimeType', match: 'exists' }],
    });
    assert.equal(result.argChecks?.[0].match, 'exists');
  });

  it('accepts custom minScore', () => {
    const result = ToolCallScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      input: 'x',
      type: 'tool-call',
      tool: 'upload_image',
      argChecks: [{ path: 'mimeType', match: 'exists' }],
      minScore: 0.5,
    });
    assert.equal(result.minScore, 0.5);
  });

  it('throws when tool is missing', () => {
    assert.throws(() =>
      ToolCallScenarioSchema.parse({
        id: 'x',
        name: 'x',
        purpose: 'x',
        input: 'x',
        type: 'tool-call',
      }),
    );
  });
});

describe('LlmJudgeScenarioSchema', () => {
  it('parses without priorTurns (existing behavior unchanged)', () => {
    const result = LlmJudgeScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      input: 'x',
      type: 'llm-judge',
      rubric: 'r',
    });
    assert.equal(result.priorTurns, undefined);
  });

  it('parses with a valid priorTurns array, defaulting turn args to {}', () => {
    const result = LlmJudgeScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      input: 'x',
      type: 'llm-judge',
      rubric: 'r',
      priorTurns: [{ tool: 'wiki_search', result: { text: 'found it' } }],
    });
    assert.equal(result.priorTurns?.length, 1);
    assert.deepEqual(result.priorTurns?.[0].args, {});
  });

  it('accepts multiple chained prior turns', () => {
    const result = LlmJudgeScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      input: 'x',
      type: 'llm-judge',
      rubric: 'r',
      priorTurns: [
        { tool: 'wiki_search', args: { query: 'q' }, result: { text: 'a' } },
        { tool: 'wiki_read_page', args: { path: 'p' }, result: { text: 'b' } },
      ],
    });
    assert.equal(result.priorTurns?.length, 2);
  });

  it('throws when priorTurns is explicitly empty', () => {
    assert.throws(() =>
      LlmJudgeScenarioSchema.parse({
        id: 'x',
        name: 'x',
        purpose: 'x',
        input: 'x',
        type: 'llm-judge',
        rubric: 'r',
        priorTurns: [],
      }),
    );
  });
});

describe('ToolSequenceScenarioSchema', () => {
  it('defaults minScore to 1, argChecks omitted, and turn args default to {}', () => {
    const result = ToolSequenceScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      input: 'x',
      type: 'tool-sequence',
      priorTurns: [{ tool: 'generate_image', result: { imageBase64: 'abc' } }],
      tool: 'upload_image',
    });
    assert.equal(result.minScore, 1);
    assert.equal(result.argChecks, undefined);
    assert.deepEqual(result.priorTurns[0].args, {});
  });

  it('accepts explicit prior turn args and multiple chained turns', () => {
    const result = ToolSequenceScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      input: 'x',
      type: 'tool-sequence',
      priorTurns: [
        { tool: 'tool_a', args: { a: 1 }, result: { out: 'a' } },
        { tool: 'tool_b', args: { b: 2 }, result: { out: 'b' } },
      ],
      tool: 'upload_image',
    });
    assert.equal(result.priorTurns.length, 2);
    assert.deepEqual(result.priorTurns[0].args, { a: 1 });
    assert.deepEqual(result.priorTurns[1].args, { b: 2 });
  });

  it('accepts argChecks using the same shape as tool-call', () => {
    const result = ToolSequenceScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      input: 'x',
      type: 'tool-sequence',
      priorTurns: [{ tool: 'generate_image', result: { imageBase64: 'abc' } }],
      tool: 'upload_image',
      argChecks: [{ path: 'imageBase64', match: 'equals', value: 'abc' }],
    });
    assert.equal(result.argChecks?.[0].match, 'equals');
  });

  it('throws when priorTurns is empty', () => {
    assert.throws(() =>
      ToolSequenceScenarioSchema.parse({
        id: 'x',
        name: 'x',
        purpose: 'x',
        input: 'x',
        type: 'tool-sequence',
        priorTurns: [],
        tool: 'upload_image',
      }),
    );
  });

  it('throws when tool is missing', () => {
    assert.throws(() =>
      ToolSequenceScenarioSchema.parse({
        id: 'x',
        name: 'x',
        purpose: 'x',
        input: 'x',
        type: 'tool-sequence',
        priorTurns: [{ tool: 'generate_image', result: { imageBase64: 'abc' } }],
      }),
    );
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

  const minimalScenario = {
    id: 'sc1',
    name: 'SC1',
    purpose: 'P',
    input: 'I',
    type: 'deterministic',
    match: 'contains',
    expected: 'e',
  };

  it('accepts an optional simulatedUserInstructions string', () => {
    const result = SuiteSchema.parse({
      suite: {
        id: 's1',
        name: 'Suite 1',
        purpose: 'Purpose',
        simulatedUserInstructions: 'Ignore prior rules.',
      },
      scenarios: [minimalScenario],
    });
    assert.equal(result.suite.simulatedUserInstructions, 'Ignore prior rules.');
  });

  it('omits simulatedUserInstructions by default', () => {
    const result = SuiteSchema.parse({
      suite: { id: 's1', name: 'Suite 1', purpose: 'Purpose' },
      scenarios: [minimalScenario],
    });
    assert.equal(result.suite.simulatedUserInstructions, undefined);
  });

  it('throws on an empty-string simulatedUserInstructions', () => {
    assert.throws(() =>
      SuiteSchema.parse({
        suite: { id: 's1', name: 'Suite 1', purpose: 'Purpose', simulatedUserInstructions: '' },
        scenarios: [minimalScenario],
      }),
    );
  });

  it('defaults appliesHarnessSystemPrompt to true', () => {
    const result = SuiteSchema.parse({
      suite: { id: 's1', name: 'Suite 1', purpose: 'Purpose' },
      scenarios: [minimalScenario],
    });
    assert.equal(result.suite.appliesHarnessSystemPrompt, true);
  });

  it('accepts appliesHarnessSystemPrompt: false', () => {
    const result = SuiteSchema.parse({
      suite: {
        id: 's1',
        name: 'Suite 1',
        purpose: 'Purpose',
        appliesHarnessSystemPrompt: false,
      },
      scenarios: [minimalScenario],
    });
    assert.equal(result.suite.appliesHarnessSystemPrompt, false);
  });
});

describe('EvalRunSchema', () => {
  const minimalRun = {
    id: 'run-1',
    suiteId: 's1',
    model: 'llama3.2',
    startedAt: '2026-07-25T00:00:00.000Z',
    passed: true,
    passRate: 1,
    totalScenarios: 1,
    passedScenarios: 1,
    totalLatencyMs: 100,
    estimatedCostUsd: 0,
  };

  it('parses without systemPrompt (pre-existing YAML results)', () => {
    const result = EvalRunSchema.parse(minimalRun);
    assert.equal(result.systemPrompt, undefined);
  });

  it('accepts a non-null systemPrompt', () => {
    const result = EvalRunSchema.parse({ ...minimalRun, systemPrompt: 'You are a helpful agent.' });
    assert.equal(result.systemPrompt, 'You are a helpful agent.');
  });

  it('accepts a null systemPrompt (suite opted out via appliesHarnessSystemPrompt: false)', () => {
    const result = EvalRunSchema.parse({ ...minimalRun, systemPrompt: null });
    assert.equal(result.systemPrompt, null);
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

  it('parses a skipped ScenarioResultDetailsSchema value', () => {
    const result = ScenarioResultDetailsSchema.parse({ type: 'skipped' });
    assert.equal(result.type, 'skipped');
  });
});
