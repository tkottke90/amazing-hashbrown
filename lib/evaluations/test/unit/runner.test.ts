import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseChatModel, BindToolsInput } from '@langchain/core/language_models/chat_models';
import {
  buildSeededMessages,
  withSystemPrompt,
  extractToolCallData,
  executeScenario,
  computeRunSummary,
  type RunConfig,
  type SkillExpansionMiddlewareLike,
  type SkillGatedToolsMiddlewareLike,
} from '../../src/runner.js';
import type {
  DeterministicScenario,
  LlmJudgeScenario,
  ToolCallScenario,
  ToolSequenceScenario,
  ScenarioResult,
  Suite,
} from '../../src/schemas.js';

// Throws if any method is called — proves the skip short-circuit never
// touches the model at all.
function neverInvokedModel(): BaseChatModel {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('model should never be invoked for a skipped scenario');
      },
    },
  ) as BaseChatModel;
}

function makeRunConfig(): RunConfig {
  return {
    suiteId: 'test-suite',
    model: neverInvokedModel(),
    modelId: 'test-model',
    judgeModel: neverInvokedModel(),
    judgeModelId: 'test-model',
    suitePaths: { bundledPath: '/dev/null' },
    resultPath: '/dev/null',
  };
}

// Captures whatever executeScenario passed to model.invoke(), so a test can
// assert on the exact input shape (string vs. seeded/system-prompted
// message array) without a real model call.
function makeCapturingModel(content: string): {
  model: BaseChatModel;
  getLastInput: () => unknown;
} {
  let lastInput: unknown;
  const model = {
    invoke: async (input: unknown) => {
      lastInput = input;
      return { content };
    },
  } as unknown as BaseChatModel;
  return { model, getLastInput: () => lastInput };
}

// runLlmJudge calls judgeModel.withStructuredOutput(schema).withRetry(opts).invoke(prompt)
// — this fake supports exactly that chain, returning a fixed verdict.
function makeFakeJudgeModel(score: number, reasoning: string): BaseChatModel {
  return {
    withStructuredOutput: () => ({
      withRetry: () => ({
        invoke: async () => ({ score, reasoning }),
      }),
    }),
  } as unknown as BaseChatModel;
}

function makeSuite(scenarios: Suite['scenarios']): Suite {
  return {
    suite: {
      id: 'test-suite',
      name: 'Test Suite',
      purpose: 'Testing',
      appliesHarnessSystemPrompt: true,
    },
    scenarios,
  };
}

describe('buildSeededMessages', () => {
  it('starts with a HumanMessage carrying the input', () => {
    const messages = buildSeededMessages('generate a dragon', [
      { tool: 'generate_image', args: { prompt: 'a dragon' }, result: { imageBase64: 'abc' } },
    ]);
    assert.ok(messages[0] instanceof HumanMessage);
    assert.equal(messages[0].content, 'generate a dragon');
  });

  it('appends one AIMessage(tool_call) + ToolMessage(result) pair per prior turn', () => {
    const messages = buildSeededMessages('x', [
      { tool: 'generate_image', args: { prompt: 'a dragon' }, result: { imageBase64: 'abc' } },
    ]);

    assert.equal(messages.length, 3);

    const ai = messages[1];
    assert.ok(ai instanceof AIMessage);
    assert.equal(ai.tool_calls?.length, 1);
    assert.equal(ai.tool_calls?.[0]?.name, 'generate_image');
    assert.deepEqual(ai.tool_calls?.[0]?.args, { prompt: 'a dragon' });
    const toolCallId = ai.tool_calls?.[0]?.id;
    assert.ok(toolCallId);

    const toolMsg = messages[2];
    assert.ok(toolMsg instanceof ToolMessage);
    assert.equal(toolMsg.tool_call_id, toolCallId);
    assert.equal(toolMsg.content, JSON.stringify({ imageBase64: 'abc' }));
  });

  it('chains multiple prior turns in order, each with a distinct tool_call_id', () => {
    const messages = buildSeededMessages('x', [
      { tool: 'tool_a', args: { a: 1 }, result: { out: 'a' } },
      { tool: 'tool_b', args: { b: 2 }, result: { out: 'b' } },
    ]);

    // Human, AI(a), Tool(a), AI(b), Tool(b)
    assert.equal(messages.length, 5);

    const aiA = messages[1] as AIMessage;
    const toolA = messages[2] as ToolMessage;
    const aiB = messages[3] as AIMessage;
    const toolB = messages[4] as ToolMessage;

    assert.equal(aiA.tool_calls?.[0]?.name, 'tool_a');
    assert.equal(toolA.tool_call_id, aiA.tool_calls?.[0]?.id);
    assert.equal(toolA.content, JSON.stringify({ out: 'a' }));

    assert.equal(aiB.tool_calls?.[0]?.name, 'tool_b');
    assert.equal(toolB.tool_call_id, aiB.tool_calls?.[0]?.id);
    assert.equal(toolB.content, JSON.stringify({ out: 'b' }));

    assert.notEqual(aiA.tool_calls?.[0]?.id, aiB.tool_calls?.[0]?.id);
  });
});

describe('withSystemPrompt', () => {
  it('returns string input unchanged when no systemPrompt is given', () => {
    const result = withSystemPrompt('hello');
    assert.equal(result, 'hello');
  });

  it('returns message-array input unchanged when no systemPrompt is given', () => {
    const messages = buildSeededMessages('x', [{ tool: 'tool_a', args: {}, result: { out: 'a' } }]);
    assert.equal(withSystemPrompt(messages), messages);
  });

  it('wraps string input in a SystemMessage + HumanMessage pair when systemPrompt is given', () => {
    const result = withSystemPrompt('hello', 'be nice');
    assert.ok(Array.isArray(result));
    const [sys, human] = result as [SystemMessage, HumanMessage];
    assert.ok(sys instanceof SystemMessage);
    assert.equal(sys.content, 'be nice');
    assert.ok(human instanceof HumanMessage);
    assert.equal(human.content, 'hello');
  });

  it('prepends a SystemMessage ahead of existing messages when systemPrompt is given', () => {
    const messages = buildSeededMessages('x', [{ tool: 'tool_a', args: {}, result: { out: 'a' } }]);
    const result = withSystemPrompt(messages, 'be nice') as (typeof messages)[number][];
    assert.equal(result.length, messages.length + 1);
    assert.ok(result[0] instanceof SystemMessage);
    assert.equal(result[0].content, 'be nice');
    assert.deepEqual(result.slice(1), messages);
  });
});

describe('extractToolCallData', () => {
  it('maps tool_calls into toolCalls, leaving invalidToolCalls empty', () => {
    const response = new AIMessage({
      content: '',
      tool_calls: [{ id: '1', name: 'wiki_search', args: { query: 'x' } }],
    });
    const result = extractToolCallData(response);
    assert.deepEqual(result.toolCalls, [{ name: 'wiki_search', args: { query: 'x' } }]);
    assert.deepEqual(result.invalidToolCalls, []);
  });

  it('maps invalid_tool_calls, preserving name/args/error, when tool_calls is empty', () => {
    const response = new AIMessage({
      content: '',
      invalid_tool_calls: [
        { name: 'wiki_search', args: '{bad json', error: 'failed to parse arguments' },
      ],
    });
    const result = extractToolCallData(response);
    assert.deepEqual(result.toolCalls, []);
    assert.deepEqual(result.invalidToolCalls, [
      { name: 'wiki_search', args: '{bad json', error: 'failed to parse arguments' },
    ]);
  });

  it('passes through a non-empty response_metadata as responseMetadata', () => {
    const response = new AIMessage({
      content: '',
      response_metadata: { done_reason: 'stop' },
    });
    const result = extractToolCallData(response);
    assert.deepEqual(result.responseMetadata, { done_reason: 'stop' });
  });

  it('returns undefined responseMetadata for an empty response_metadata object', () => {
    const response = new AIMessage({ content: '', response_metadata: {} });
    const result = extractToolCallData(response);
    assert.equal(result.responseMetadata, undefined);
  });

  it('still extracts content correctly alongside the new fields', () => {
    const response = new AIMessage({ content: 'hello there' });
    const result = extractToolCallData(response);
    assert.equal(result.content, 'hello there');
  });

  it('captures additional_kwargs.reasoning_content as reasoningContent', () => {
    const response = new AIMessage({
      content: '',
      additional_kwargs: { reasoning_content: 'the model thinking out loud' },
    });
    const result = extractToolCallData(response);
    assert.equal(result.reasoningContent, 'the model thinking out loud');
  });

  it('returns undefined reasoningContent when additional_kwargs has no reasoning_content', () => {
    const response = new AIMessage({ content: '', additional_kwargs: {} });
    const result = extractToolCallData(response);
    assert.equal(result.reasoningContent, undefined);
  });

  it('returns undefined reasoningContent for an empty reasoning_content string', () => {
    const response = new AIMessage({
      content: '',
      additional_kwargs: { reasoning_content: '' },
    });
    const result = extractToolCallData(response);
    assert.equal(result.reasoningContent, undefined);
  });
});

describe('executeScenario — skip', () => {
  function makeScenario(overrides: Partial<DeterministicScenario> = {}): DeterministicScenario {
    return {
      id: 'sc-skip',
      name: 'Skippable scenario',
      purpose: 'p',
      input: 'i',
      type: 'deterministic',
      match: 'contains',
      expected: 'e',
      ...overrides,
    };
  }

  it('short-circuits without invoking the model when skip is true', async () => {
    const scenario = makeScenario({ skip: true });
    const suite = makeSuite([scenario]);
    const result = await executeScenario(scenario, suite, 'run-1', makeRunConfig(), {
      count: 0,
      total: 0,
    });
    assert.equal(result.passed, false);
    assert.equal(result.score, null);
    assert.equal(result.actualOutput, '');
    assert.equal(result.latencyMs, 0);
    assert.equal(result.details.type, 'skipped');
  });

  it('actually invokes the model (and hits our throwing fake) when skip is false', async () => {
    // executeScenario's outer try/catch converts a scenario-execution error
    // into a normal (non-rejecting) "scenario errored" result — so this
    // proves the model really was called, distinct from the skip-true
    // case above, without needing to assert a rejection.
    const scenario = makeScenario({ skip: false });
    const suite = makeSuite([scenario]);
    const result = await executeScenario(scenario, suite, 'run-1', makeRunConfig(), {
      count: 0,
      total: 0,
    });
    assert.ok(result.actualOutput.includes('model should never be invoked'));
  });
});

describe('executeScenario — llm-judge', () => {
  function makeScenario(overrides: Partial<LlmJudgeScenario> = {}): LlmJudgeScenario {
    return {
      id: 'sc-judge',
      name: 'Judged scenario',
      purpose: 'p',
      input: 'what do you know about me?',
      type: 'llm-judge',
      rubric: 'r',
      minScore: 7,
      ...overrides,
    };
  }

  it('invokes the model with the plain string input when neither systemPrompt nor priorTurns is set', async () => {
    const scenario = makeScenario();
    const suite = makeSuite([scenario]);
    const { model, getLastInput } = makeCapturingModel('I have nothing on you yet.');
    const config: RunConfig = {
      ...makeRunConfig(),
      model,
      judgeModel: makeFakeJudgeModel(8, 'Good'),
    };

    await executeScenario(scenario, suite, 'run-1', config, { count: 0, total: 0 });

    assert.equal(getLastInput(), 'what do you know about me?');
  });

  it('attaches the system prompt as a SystemMessage when config.systemPrompt is set', async () => {
    const scenario = makeScenario();
    const suite = makeSuite([scenario]);
    const { model, getLastInput } = makeCapturingModel('I have nothing on you yet.');
    const config: RunConfig = {
      ...makeRunConfig(),
      model,
      judgeModel: makeFakeJudgeModel(8, 'Good'),
      systemPrompt: 'You have no built-in memory of this specific user.',
    };

    await executeScenario(scenario, suite, 'run-1', config, { count: 0, total: 0 });

    const input = getLastInput() as [SystemMessage, HumanMessage];
    assert.ok(Array.isArray(input));
    assert.ok(input[0] instanceof SystemMessage);
    assert.equal(input[0].content, 'You have no built-in memory of this specific user.');
    assert.ok(input[1] instanceof HumanMessage);
    assert.equal(input[1].content, 'what do you know about me?');
  });

  it('seeds priorTurns into the conversation before invoking', async () => {
    const scenario = makeScenario({
      priorTurns: [{ tool: 'wiki_search', args: { query: 'q' }, result: { text: 'found it' } }],
    });
    const suite = makeSuite([scenario]);
    const { model, getLastInput } = makeCapturingModel('Here is what I found.');
    const config: RunConfig = {
      ...makeRunConfig(),
      model,
      judgeModel: makeFakeJudgeModel(9, 'Great'),
    };

    await executeScenario(scenario, suite, 'run-1', config, { count: 0, total: 0 });

    const input = getLastInput() as unknown[];
    assert.ok(Array.isArray(input));
    // Human, AI(tool_call), Tool(result) — no SystemMessage since config.systemPrompt is unset.
    assert.equal(input.length, 3);
    assert.ok(input[0] instanceof HumanMessage);
    assert.ok(input[1] instanceof AIMessage);
    assert.ok(input[2] instanceof ToolMessage);
  });

  it('does not bind tools for llm-judge, even when config.tools is set', async () => {
    const scenario = makeScenario({
      priorTurns: [{ tool: 'wiki_search', args: {}, result: { text: 'found it' } }],
    });
    const suite = makeSuite([scenario]);
    const { model, getLastInput } = makeCapturingModel('Here is what I found.');
    // bindTools would throw if ever called — proving llm-judge stays on invokeModel.
    const modelWithThrowingBindTools = new Proxy(model, {
      get(target, prop) {
        if (prop === 'bindTools') {
          throw new Error('bindTools should never be called for llm-judge scenarios');
        }
        return Reflect.get(target as object, prop);
      },
    }) as BaseChatModel;
    const config: RunConfig = {
      ...makeRunConfig(),
      model: modelWithThrowingBindTools,
      judgeModel: makeFakeJudgeModel(9, 'Great'),
      tools: [],
    };

    const result = await executeScenario(scenario, suite, 'run-1', config, {
      count: 0,
      total: 0,
    });

    assert.equal(result.details.type, 'llm-judge');
    assert.ok(getLastInput());
  });

  it('falls back to additional_kwargs.reasoning_content when .content is empty', async () => {
    // Ollama "thinking" models (gpt-oss, qwen3) can leave .content empty
    // while putting the real answer in reasoning_content instead — this used
    // to score as an empty response even though the model actually answered.
    const scenario = makeScenario();
    const suite = makeSuite([scenario]);
    const model = {
      invoke: async () =>
        new AIMessage({
          content: '',
          additional_kwargs: { reasoning_content: 'I have nothing on you yet.' },
        }),
    } as unknown as BaseChatModel;
    const config: RunConfig = {
      ...makeRunConfig(),
      model,
      judgeModel: makeFakeJudgeModel(8, 'Good'),
    };

    const result = await executeScenario(scenario, suite, 'run-1', config, {
      count: 0,
      total: 0,
    });

    assert.equal(result.actualOutput, 'I have nothing on you yet.');
  });
});

// Captures the tools executeScenario's tool-call/tool-sequence branches
// bound via model.bindTools(tools), plus the exact input passed to the
// resulting .invoke() — distinct from makeCapturingModel above, which only
// supports the plain .invoke() path (llm-judge/deterministic/semantic).
function makeCapturingBindToolsModel(toolCallName: string): {
  model: BaseChatModel;
  getBoundTools: () => BindToolsInput[];
  getLastInput: () => unknown;
} {
  let boundTools: BindToolsInput[] = [];
  let lastInput: unknown;
  const model = {
    bindTools: (tools: BindToolsInput[]) => {
      boundTools = tools;
      return {
        invoke: async (input: unknown) => {
          lastInput = input;
          return {
            tool_calls: [{ id: 'call-1', name: toolCallName, args: {} }],
            content: '',
          };
        },
      };
    },
  } as unknown as BaseChatModel;
  return { model, getBoundTools: () => boundTools, getLastInput: () => lastInput };
}

function fakeTool(name: string): BindToolsInput {
  return { name } as unknown as BindToolsInput;
}

describe('executeScenario — gatedSkill (tool-call/tool-sequence)', () => {
  const ALWAYS_ON = fakeTool('ask_user');
  const GATED = fakeTool('create_workspace');

  // Mirrors the real skillExpansionMiddleware's own behavior on a small
  // scale: recognizes exactly one slash command, rewrites the message and
  // reports activeGatedSkill when matched, returns undefined (its real
  // no-op shape for plain-chat/unrecognized text) otherwise.
  function makeFakeExpansionMiddleware(
    command: string,
    expandedBody: string,
  ): SkillExpansionMiddlewareLike & { callCount: () => number } {
    let calls = 0;
    return {
      callCount: () => calls,
      beforeAgent: async (state) => {
        calls += 1;
        const last = state.messages[state.messages.length - 1];
        const content = last?.content;
        if (typeof content !== 'string' || !content.startsWith(`/${command}`)) return undefined;
        const messages = [...state.messages];
        messages[messages.length - 1] = new HumanMessage(expandedBody);
        return { messages, activeGatedSkill: command };
      },
    };
  }

  // Mirrors the real skillGatedToolsMiddleware: always-on tools stay,
  // GATED is added only when activeGatedSkill matches the registered command.
  function makeFakeGatingMiddleware(command: string): SkillGatedToolsMiddlewareLike {
    return {
      wrapModelCall: async (request, handler) => {
        const tools =
          request.state.activeGatedSkill === command ? [...request.tools, GATED] : request.tools;
        return handler({ ...request, tools });
      },
    };
  }

  function makeToolCallScenario(overrides: Partial<ToolCallScenario> = {}): ToolCallScenario {
    return {
      id: 'gated-tc-1',
      name: 'Gated tool-call scenario',
      purpose: 'Testing',
      type: 'tool-call',
      input: '/fake-skill do the thing',
      tool: GATED.name as string,
      minScore: 1,
      gatedSkill: 'fake-skill',
      ...overrides,
    };
  }

  it('fresh invocation: expands the real skill body and exposes the gated tool', async () => {
    const scenario = makeToolCallScenario();
    const suite = makeSuite([scenario]);
    const { model, getBoundTools, getLastInput } = makeCapturingBindToolsModel(
      GATED.name as string,
    );
    const expansion = makeFakeExpansionMiddleware('fake-skill', 'EXPANDED SKILL BODY');
    const config: RunConfig = {
      ...makeRunConfig(),
      model,
      tools: [ALWAYS_ON],
      skillExpansionMiddleware: expansion,
      skillGatedToolsMiddleware: makeFakeGatingMiddleware('fake-skill'),
    };

    await executeScenario(scenario, suite, 'run-1', config, { count: 0, total: 0 });

    assert.deepEqual(
      getBoundTools().map((t) => (t as { name: string }).name),
      ['ask_user', 'create_workspace'],
    );
    const input = getLastInput() as HumanMessage[];
    assert.equal(input[0]!.content, 'EXPANDED SKILL BODY');
  });

  it('continuation: falls back to the declared gatedSkill when input is plain text', async () => {
    const scenario: ToolSequenceScenario = {
      id: 'gated-ts-1',
      name: 'Gated tool-sequence scenario',
      purpose: 'Testing',
      type: 'tool-sequence',
      input: 'Yes, that looks right.',
      priorTurns: [{ tool: 'ask_user', args: { question: 'confirm?' }, result: { text: 'yes' } }],
      tool: GATED.name as string,
      minScore: 1,
      gatedSkill: 'fake-skill',
    };
    const suite = makeSuite([scenario]);
    const { model, getBoundTools } = makeCapturingBindToolsModel(GATED.name as string);
    const expansion = makeFakeExpansionMiddleware('fake-skill', 'EXPANDED SKILL BODY');
    const config: RunConfig = {
      ...makeRunConfig(),
      model,
      tools: [ALWAYS_ON],
      skillExpansionMiddleware: expansion,
      skillGatedToolsMiddleware: makeFakeGatingMiddleware('fake-skill'),
    };

    await executeScenario(scenario, suite, 'run-1', config, { count: 0, total: 0 });

    // beforeAgent was called (runner always defers to the real middleware
    // first) but took its own no-op path since 'Yes, that looks right.'
    // isn't a slash command — proving the fallback to scenario.gatedSkill
    // is what actually resolved the gate here, not a lucky expansion match.
    assert.equal(expansion.callCount(), 1);
    assert.deepEqual(
      getBoundTools().map((t) => (t as { name: string }).name),
      ['ask_user', 'create_workspace'],
    );
  });

  it('is inert when gatedSkill is unset, even with both middlewares present in config', async () => {
    const scenario = makeToolCallScenario({ input: 'plain text, no skill', gatedSkill: undefined });
    const suite = makeSuite([scenario]);
    const { model, getBoundTools } = makeCapturingBindToolsModel('ask_user');
    const config: RunConfig = {
      ...makeRunConfig(),
      model,
      tools: [ALWAYS_ON],
      skillExpansionMiddleware: makeFakeExpansionMiddleware('fake-skill', 'EXPANDED SKILL BODY'),
      skillGatedToolsMiddleware: makeFakeGatingMiddleware('fake-skill'),
    };

    await executeScenario(scenario, suite, 'run-1', config, { count: 0, total: 0 });

    assert.deepEqual(
      getBoundTools().map((t) => (t as { name: string }).name),
      ['ask_user'],
    );
  });

  it('errors (not crashes) when gatedSkill is set but skillGatedToolsMiddleware is missing', async () => {
    const scenario = makeToolCallScenario();
    const suite = makeSuite([scenario]);
    const { model } = makeCapturingBindToolsModel(GATED.name as string);
    const config: RunConfig = {
      ...makeRunConfig(),
      model,
      tools: [ALWAYS_ON],
    };

    const result = await executeScenario(scenario, suite, 'run-1', config, {
      count: 0,
      total: 0,
    });

    assert.equal(result.passed, false);
    assert.ok(result.actualOutput.includes('gatedSkill'));
  });
});

describe('computeRunSummary', () => {
  function makeResult(overrides: Partial<ScenarioResult> = {}): ScenarioResult {
    return {
      id: 'r-1',
      runId: 'run-1',
      scenarioId: 'sc-1',
      suiteId: 'test-suite',
      passed: true,
      score: 1,
      actualOutput: 'ok',
      latencyMs: 10,
      estimatedCostUsd: 0,
      details: { type: 'deterministic', match: 'contains', expected: 'e', passed: true },
      ...overrides,
    };
  }

  it('counts skipped results in totalScenarios but excludes them from passRate', () => {
    const results: ScenarioResult[] = [
      makeResult({ scenarioId: 'sc-pass', passed: true }),
      makeResult({
        scenarioId: 'sc-skip',
        passed: false,
        score: null,
        details: { type: 'skipped' },
      }),
    ];
    const suite = makeSuite([]);
    const run = computeRunSummary(results, suite, 'run-1', 'model-a', 'model-a', '2026-01-01');
    assert.equal(run.totalScenarios, 2);
    assert.equal(run.passedScenarios, 1);
    assert.equal(run.passRate, 1);
    assert.equal(run.passed, true);
  });

  it('a failing non-skipped scenario still counts against passRate alongside a skip', () => {
    const results: ScenarioResult[] = [
      makeResult({ scenarioId: 'sc-fail', passed: false }),
      makeResult({
        scenarioId: 'sc-skip',
        passed: false,
        score: null,
        details: { type: 'skipped' },
      }),
    ];
    const suite = makeSuite([]);
    const run = computeRunSummary(results, suite, 'run-1', 'model-a', 'model-a', '2026-01-01');
    assert.equal(run.totalScenarios, 2);
    assert.equal(run.passedScenarios, 0);
    assert.equal(run.passRate, 0);
  });

  it('sets systemPrompt to the given value when provided', () => {
    const suite = makeSuite([]);
    const run = computeRunSummary(
      [],
      suite,
      'run-1',
      'model-a',
      'model-a',
      '2026-01-01',
      'be nice',
    );
    assert.equal(run.systemPrompt, 'be nice');
  });

  it('sets systemPrompt to null when omitted (suite opted out)', () => {
    const suite = makeSuite([]);
    const run = computeRunSummary([], suite, 'run-1', 'model-a', 'model-a', '2026-01-01');
    assert.equal(run.systemPrompt, null);
  });
});
