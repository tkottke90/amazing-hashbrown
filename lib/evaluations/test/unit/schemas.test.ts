import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import {
  ScenarioSchema,
  HumanScenarioSchema,
  DeterministicScenarioSchema,
  LlmJudgeScenarioSchema,
  SemanticScenarioSchema,
  StructuredScenarioSchema,
  ToolCallScenarioSchema,
  ToolSequenceScenarioSchema,
  SuiteSchema,
  EvalRunSchema,
  JsonOf,
  ScenarioResultDetailsSchema,
  validateScenarioTurns,
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
      type: 'tool-sequence',
      turns: [{ user: 'Input' }, { tool: 'generate_image', result: { imageBase64: 'abc' } }],
      tool: 'upload_image',
    });
    assert.equal(result.type, 'tool-sequence');
    if (result.type === 'tool-sequence') {
      assert.equal(result.minScore, 1);
      assert.deepEqual(result.turns, [
        { user: 'Input' },
        { tool: 'generate_image', args: {}, result: { imageBase64: 'abc' } },
      ]);
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

  it('accepts a responseRubric and responseMinScore for judging the reply text [unit]', () => {
    const result = ToolCallScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      input: 'x',
      type: 'tool-call',
      tool: '!schedule_wakeup',
      responseRubric: 'Does not promise a reminder.',
      responseMinScore: 8,
    });
    assert.equal(result.responseRubric, 'Does not promise a reminder.');
    assert.equal(result.responseMinScore, 8);
  });

  it('rejects a responseMinScore above the 0-10 judge scale [unit]', () => {
    assert.throws(() =>
      ToolCallScenarioSchema.parse({
        id: 'x',
        name: 'x',
        purpose: 'x',
        input: 'x',
        type: 'tool-call',
        tool: '!schedule_wakeup',
        responseRubric: 'r',
        responseMinScore: 11,
      }),
    );
  });
});

describe('LlmJudgeScenarioSchema', () => {
  it('parses with a plain input string and no turns (existing behavior unchanged) [unit]', () => {
    const result = LlmJudgeScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      input: 'x',
      type: 'llm-judge',
      rubric: 'r',
    });
    assert.equal(result.turns, undefined);
  });

  it('parses with a valid turns array opening on a user entry, defaulting tool-turn args to {} [unit]', () => {
    const result = LlmJudgeScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      type: 'llm-judge',
      rubric: 'r',
      turns: [{ user: 'x' }, { tool: 'wiki_search', result: { text: 'found it' } }],
    });
    assert.equal(result.turns?.length, 2);
    assert.deepEqual(result.turns?.[1], {
      tool: 'wiki_search',
      args: {},
      result: { text: 'found it' },
    });
  });

  it('accepts multiple chained tool turns after the opening user turn [unit]', () => {
    const result = LlmJudgeScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      type: 'llm-judge',
      rubric: 'r',
      turns: [
        { user: 'x' },
        { tool: 'wiki_search', args: { query: 'q' }, result: { text: 'a' } },
        { tool: 'wiki_read_page', args: { path: 'p' }, result: { text: 'b' } },
      ],
    });
    assert.equal(result.turns?.length, 3);
  });

  it('throws when turns does not open with a user entry (issue #235) [unit]', () => {
    assert.throws(() =>
      LlmJudgeScenarioSchema.parse({
        id: 'x',
        name: 'x',
        purpose: 'x',
        type: 'llm-judge',
        rubric: 'r',
        turns: [{ tool: 'wiki_search', result: { text: 'a' } }, { user: 'x' }],
      }),
    );
  });

  it('throws when turns has fewer than 2 entries [unit]', () => {
    assert.throws(() =>
      LlmJudgeScenarioSchema.parse({
        id: 'x',
        name: 'x',
        purpose: 'x',
        type: 'llm-judge',
        rubric: 'r',
        turns: [{ user: 'x' }],
      }),
    );
  });

  it('rejects the old priorTurns field now that turns replaces it [unit]', () => {
    assert.throws(() =>
      LlmJudgeScenarioSchema.parse({
        id: 'x',
        name: 'x',
        purpose: 'x',
        input: 'x',
        type: 'llm-judge',
        rubric: 'r',
        priorTurns: [{ tool: 'wiki_search', result: { text: 'a' } }],
      }),
    );
  });
});

describe('ToolSequenceScenarioSchema', () => {
  it('defaults minScore to 1, argChecks omitted, and tool-turn args default to {} [unit]', () => {
    const result = ToolSequenceScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      type: 'tool-sequence',
      turns: [{ user: 'x' }, { tool: 'generate_image', result: { imageBase64: 'abc' } }],
      tool: 'upload_image',
    });
    assert.equal(result.minScore, 1);
    assert.equal(result.argChecks, undefined);
    assert.deepEqual(result.turns[1], {
      tool: 'generate_image',
      args: {},
      result: { imageBase64: 'abc' },
    });
  });

  it('accepts explicit tool-turn args and multiple chained turns [unit]', () => {
    const result = ToolSequenceScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      type: 'tool-sequence',
      turns: [
        { user: 'x' },
        { tool: 'tool_a', args: { a: 1 }, result: { out: 'a' } },
        { tool: 'tool_b', args: { b: 2 }, result: { out: 'b' } },
      ],
      tool: 'upload_image',
    });
    assert.equal(result.turns.length, 3);
  });

  it("accepts a reply turn placed after the tool turns it answers (issue #235's actual fix) [unit]", () => {
    const result = ToolSequenceScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      type: 'tool-sequence',
      turns: [
        { user: 'Create a project "Ship Homepage Redesign"...' },
        {
          tool: 'ask_user',
          args: { question: 'Create project...?' },
          result: { text: 'User answered: yes' },
        },
        { user: 'Yep, go ahead.' },
      ],
      tool: 'create_project',
    });
    assert.equal(result.turns.length, 3);
    assert.deepEqual(result.turns[2], { user: 'Yep, go ahead.' });
  });

  it('accepts argChecks using the same shape as tool-call [unit]', () => {
    const result = ToolSequenceScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      type: 'tool-sequence',
      turns: [{ user: 'x' }, { tool: 'generate_image', result: { imageBase64: 'abc' } }],
      tool: 'upload_image',
      argChecks: [{ path: 'imageBase64', match: 'equals', value: 'abc' }],
    });
    assert.equal(result.argChecks?.[0].match, 'equals');
  });

  it('throws when turns does not open with a user entry [unit]', () => {
    assert.throws(() =>
      ToolSequenceScenarioSchema.parse({
        id: 'x',
        name: 'x',
        purpose: 'x',
        type: 'tool-sequence',
        turns: [{ tool: 'generate_image', result: { imageBase64: 'abc' } }, { user: 'x' }],
        tool: 'upload_image',
      }),
    );
  });

  it('throws when tool is missing [unit]', () => {
    assert.throws(() =>
      ToolSequenceScenarioSchema.parse({
        id: 'x',
        name: 'x',
        purpose: 'x',
        type: 'tool-sequence',
        turns: [{ user: 'x' }, { tool: 'generate_image', result: { imageBase64: 'abc' } }],
      }),
    );
  });

  it('rejects the old priorTurns field now that turns replaces it [unit]', () => {
    assert.throws(() =>
      ToolSequenceScenarioSchema.parse({
        id: 'x',
        name: 'x',
        purpose: 'x',
        input: 'x',
        type: 'tool-sequence',
        priorTurns: [{ tool: 'generate_image', result: { imageBase64: 'abc' } }],
        tool: 'upload_image',
      }),
    );
  });

  it('accepts a responseRubric and responseMinScore for judging the reply text [unit]', () => {
    const result = ToolSequenceScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      type: 'tool-sequence',
      turns: [{ user: 'x' }, { tool: 'generate_image', result: { imageBase64: 'abc' } }],
      tool: 'upload_image',
      responseRubric: 'Does not promise a reminder.',
      responseMinScore: 8,
    });
    assert.equal(result.responseRubric, 'Does not promise a reminder.');
    assert.equal(result.responseMinScore, 8);
  });

  it('rejects a responseMinScore above the 0-10 judge scale [unit]', () => {
    assert.throws(() =>
      ToolSequenceScenarioSchema.parse({
        id: 'x',
        name: 'x',
        purpose: 'x',
        type: 'tool-sequence',
        turns: [{ user: 'x' }, { tool: 'generate_image', result: { imageBase64: 'abc' } }],
        tool: 'upload_image',
        responseRubric: 'r',
        responseMinScore: 11,
      }),
    );
  });
});

describe('DeterministicScenarioSchema turns/steps (issue #235)', () => {
  it('parses with a plain input string and no turns (existing behavior unchanged) [unit]', () => {
    const result = DeterministicScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      input: 'x',
      type: 'deterministic',
      match: 'contains',
      expected: 'e',
    });
    assert.equal(result.input, 'x');
    assert.equal(result.turns, undefined);
  });

  it('parses a steps array with an intermediate assert and the default last-step assertion [unit]', () => {
    const result = DeterministicScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      type: 'deterministic',
      match: 'contains',
      expected: 'final',
      steps: [
        { user: 'first', assert: { match: 'contains', expected: 'intermediate' } },
        { user: 'second' },
      ],
    });
    assert.equal(result.steps?.length, 2);
    assert.equal(result.steps?.[0].assert?.expected, 'intermediate');
    assert.equal(result.steps?.[1].assert, undefined);
  });

  it('accepts per-step mocks keyed by tool name [unit]', () => {
    const result = DeterministicScenarioSchema.parse({
      id: 'x',
      name: 'x',
      purpose: 'x',
      type: 'deterministic',
      match: 'contains',
      expected: 'final',
      steps: [
        { user: 'first', mocks: { wiki_search: { text: 'mocked result' } } },
        { user: 'second' },
      ],
    });
    assert.deepEqual(result.steps?.[0].mocks, { wiki_search: { text: 'mocked result' } });
  });
});

describe('validateScenarioTurns (issue #235 — cross-field invariants)', () => {
  const base = { id: 'x', name: 'x', purpose: 'x' } as const;

  it('allows a deterministic scenario with only input', () => {
    const scenario = DeterministicScenarioSchema.parse({
      ...base,
      input: 'x',
      type: 'deterministic',
      match: 'contains',
      expected: 'e',
    });
    assert.equal(validateScenarioTurns(scenario), null);
  });

  it('rejects a deterministic scenario with neither input nor turns', () => {
    const scenario = DeterministicScenarioSchema.parse({
      ...base,
      type: 'deterministic',
      match: 'contains',
      expected: 'e',
    });
    assert.match(validateScenarioTurns(scenario) ?? '', /exactly one of input or turns/);
  });

  it('rejects a steps scenario that also sets input', () => {
    const scenario = DeterministicScenarioSchema.parse({
      ...base,
      input: 'x',
      type: 'deterministic',
      match: 'contains',
      expected: 'e',
      steps: [{ user: 'a' }, { user: 'b' }],
    });
    assert.match(validateScenarioTurns(scenario) ?? '', /input must be omitted when steps is set/);
  });

  it('rejects a tool-sequence scenario with neither turns nor steps', () => {
    const scenario = ToolSequenceScenarioSchema.parse({
      ...base,
      type: 'tool-sequence',
      tool: 'upload_image',
    });
    assert.match(validateScenarioTurns(scenario) ?? '', /must set turns or steps/);
  });

  it('allows a tool-sequence scenario with only steps (no turns prefix)', () => {
    const scenario = ToolSequenceScenarioSchema.parse({
      ...base,
      type: 'tool-sequence',
      tool: 'upload_image',
      steps: [{ user: 'a' }, { user: 'b' }],
    });
    assert.equal(validateScenarioTurns(scenario), null);
  });

  it('ignores scenario types that never had priorTurns', () => {
    const scenario = ToolCallScenarioSchema.parse({
      ...base,
      input: 'x',
      type: 'tool-call',
      tool: 'upload_image',
    });
    assert.equal(validateScenarioTurns(scenario), null);
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

  it('accepts an optional simulatedTask with a plan, so a suite can put a task-run context block in the prompt', () => {
    const result = SuiteSchema.parse({
      suite: {
        id: 's1',
        name: 'Suite 1',
        purpose: 'Purpose',
        simulatedTask: {
          title: 'Ship it',
          outcome: 'Shipped',
          plan: [{ step: 'Write code', done: false }],
        },
      },
      scenarios: [minimalScenario],
    });
    assert.deepEqual(result.suite.simulatedTask, {
      title: 'Ship it',
      outcome: 'Shipped',
      plan: [{ step: 'Write code', done: false }],
    });
  });

  it('omits simulatedTask by default, leaving existing suites on the plain chat prompt', () => {
    const result = SuiteSchema.parse({
      suite: { id: 's1', name: 'Suite 1', purpose: 'Purpose' },
      scenarios: [minimalScenario],
    });
    assert.equal(result.suite.simulatedTask, undefined);
  });

  it('throws on a simulatedTask with no title, since the task prompt always names the task', () => {
    assert.throws(() =>
      SuiteSchema.parse({
        suite: { id: 's1', name: 'Suite 1', purpose: 'Purpose', simulatedTask: { title: '' } },
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

  it('accepts an optional simulatedNow ISO datetime string', () => {
    const result = SuiteSchema.parse({
      suite: {
        id: 's1',
        name: 'Suite 1',
        purpose: 'Purpose',
        simulatedNow: '2026-06-15T12:00:00.000Z',
      },
      scenarios: [minimalScenario],
    });
    assert.equal(result.suite.simulatedNow, '2026-06-15T12:00:00.000Z');
  });

  it('omits simulatedNow by default, leaving ambient context on the real current time', () => {
    const result = SuiteSchema.parse({
      suite: { id: 's1', name: 'Suite 1', purpose: 'Purpose' },
      scenarios: [minimalScenario],
    });
    assert.equal(result.suite.simulatedNow, undefined);
  });

  it('throws on a simulatedNow that is not a valid ISO datetime string', () => {
    assert.throws(() =>
      SuiteSchema.parse({
        suite: { id: 's1', name: 'Suite 1', purpose: 'Purpose', simulatedNow: 'June 15th' },
        scenarios: [minimalScenario],
      }),
    );
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

  it('parses without scoredScenarios (pre-existing YAML/DB results)', () => {
    const result = EvalRunSchema.parse(minimalRun);
    assert.equal(result.scoredScenarios, undefined);
  });

  it('accepts a scoredScenarios value', () => {
    const result = EvalRunSchema.parse({ ...minimalRun, scoredScenarios: 1 });
    assert.equal(result.scoredScenarios, 1);
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

describe('ScenarioResultDetailsSchema — malformedToolCall / proseQuestion', () => {
  it('parses a tool-call result carrying malformedToolCall', () => {
    const result = ScenarioResultDetailsSchema.parse({
      type: 'tool-call',
      expectedTool: 'wiki_search',
      toolCalled: null,
      fieldResults: [],
      score: 0,
      malformedToolCall: { parsedToolName: 'wiki_search', raw: '<tool_call>...' },
    });
    assert.equal(result.type, 'tool-call');
    assert.deepEqual(result.type === 'tool-call' ? result.malformedToolCall : undefined, {
      parsedToolName: 'wiki_search',
      raw: '<tool_call>...',
    });
  });

  it('parses a tool-sequence result carrying proseQuestion', () => {
    const result = ScenarioResultDetailsSchema.parse({
      type: 'tool-sequence',
      expectedTool: 'ask_user',
      toolCalled: null,
      fieldResults: [],
      score: 0,
      proseQuestion: { raw: 'Which domain did you mean?' },
    });
    assert.equal(result.type, 'tool-sequence');
    assert.deepEqual(result.type === 'tool-sequence' ? result.proseQuestion : undefined, {
      raw: 'Which domain did you mean?',
    });
  });

  it('parses an llm-judge result carrying malformedToolCall', () => {
    const result = ScenarioResultDetailsSchema.parse({
      type: 'llm-judge',
      score: 2,
      reasoning: 'Raw tool call text, not a real answer.',
      judgeModel: 'test-model',
      biasRisk: false,
      malformedToolCall: { parsedToolName: null, raw: '<tool_call>...' },
    });
    assert.equal(result.type, 'llm-judge');
  });

  it('still parses pre-existing tool-call results with neither field present, no migration needed', () => {
    const result = ScenarioResultDetailsSchema.parse({
      type: 'tool-call',
      expectedTool: 'wiki_search',
      toolCalled: 'wiki_search',
      fieldResults: [],
      score: 1,
    });
    assert.equal(result.type, 'tool-call');
    assert.equal(result.type === 'tool-call' ? result.malformedToolCall : 'n/a', undefined);
  });
});
