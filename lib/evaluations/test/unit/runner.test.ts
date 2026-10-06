import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseChatModel, BindToolsInput } from '@langchain/core/language_models/chat_models';
import {
  buildTurnMessages,
  messagesToConversation,
  withSystemPrompt,
  extractToolCallData,
  executeScenario,
  computeRunSummary,
  getScoredScenarios,
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
  EvalRun,
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

describe('buildTurnMessages', () => {
  it('turns a leading { user } entry into a HumanMessage', () => {
    const messages = buildTurnMessages([
      { user: 'generate a dragon' },
      { tool: 'generate_image', args: { prompt: 'a dragon' }, result: { imageBase64: 'abc' } },
    ]);
    assert.ok(messages[0] instanceof HumanMessage);
    assert.equal(messages[0].content, 'generate a dragon');
  });

  it('turns a { tool } entry into an AIMessage(tool_call) + ToolMessage(result) pair', () => {
    const messages = buildTurnMessages([
      { user: 'x' },
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

  it('chains multiple tool turns in order, each with a distinct tool_call_id', () => {
    const messages = buildTurnMessages([
      { user: 'x' },
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

  it("places a reply after the tool turns it answers — issue #235's actual fix [unit]", () => {
    // Before #235, a scenario like this always put the reply first, so the
    // model saw the answer before the question it was answering.
    const messages = buildTurnMessages([
      { user: 'Create a project "Ship Homepage Redesign"...' },
      {
        tool: 'ask_user',
        args: { question: 'Create project...?' },
        result: { text: 'User answered: yes' },
      },
      { user: 'Yep, go ahead.' },
    ]);

    assert.equal(messages.length, 4);
    assert.ok(messages[0] instanceof HumanMessage);
    assert.equal(messages[0].content, 'Create a project "Ship Homepage Redesign"...');
    assert.ok(messages[1] instanceof AIMessage);
    assert.ok(messages[2] instanceof ToolMessage);
    // The reply is the LAST message, after the tool call+result it answers
    // — not the first, as buildSeededMessages (this function's
    // predecessor) always produced regardless of what the YAML intended.
    assert.ok(messages[3] instanceof HumanMessage);
    assert.equal(messages[3].content, 'Yep, go ahead.');
  });
});

describe('messagesToConversation (issue #235 — full-transcript reporting)', () => {
  it('maps each message kind to its conversation role', () => {
    const entries = messagesToConversation([
      new HumanMessage('hi'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: '1', name: 'wiki_search', args: { q: 'x' } }],
      }),
      new ToolMessage({ tool_call_id: '1', content: '{"text":"found"}' }),
      new AIMessage('here you go'),
    ]);
    assert.deepEqual(entries, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ name: 'wiki_search', args: { q: 'x' } }] },
      { role: 'tool', content: '{"text":"found"}' },
      { role: 'assistant', content: 'here you go' },
    ]);
  });
});

describe('withSystemPrompt', () => {
  it('returns string input unchanged when no systemPrompt is given', () => {
    const result = withSystemPrompt('hello');
    assert.equal(result, 'hello');
  });

  it('returns message-array input unchanged when no systemPrompt is given', () => {
    const messages = buildTurnMessages([
      { user: 'x' },
      { tool: 'tool_a', args: {}, result: { out: 'a' } },
    ]);
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
    const messages = buildTurnMessages([
      { user: 'x' },
      { tool: 'tool_a', args: {}, result: { out: 'a' } },
    ]);
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

  it('invokes the model with the plain string input when neither systemPrompt nor turns is set', async () => {
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

  it('seeds turns into the conversation before invoking', async () => {
    const scenario = makeScenario({
      input: undefined,
      turns: [
        { user: 'what do you know about me?' },
        { tool: 'wiki_search', args: { query: 'q' }, result: { text: 'found it' } },
      ],
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
      input: undefined,
      turns: [
        { user: 'what do you know about me?' },
        { tool: 'wiki_search', args: {}, result: { text: 'found it' } },
      ],
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

// A tools-bound model whose single reply calls the given tools (possibly
// none) and says `content` — unlike makeCapturingBindToolsModel, this lets a
// test control tool_calls and content independently, which the malformed-
// tool-call/prose-question tests need (empty tool_calls, specific text).
function makeReplyingModel(content: string, toolCallNames: string[] = []): BaseChatModel {
  return {
    bindTools: () => ({
      invoke: async () => ({
        tool_calls: toolCallNames.map((name, i) => ({ id: `call-${i}`, name, args: {} })),
        content,
      }),
    }),
  } as unknown as BaseChatModel;
}

describe('executeScenario — tool-call responseRubric', () => {
  // A judge that records the prompt it was given and returns a fixed score.
  function makeRecordingJudge(score: number): { judge: BaseChatModel; prompts: string[] } {
    const prompts: string[] = [];
    const judge = {
      withStructuredOutput: () => ({
        withRetry: () => ({
          invoke: async (prompt: string) => {
            prompts.push(prompt);
            return { score, reasoning: 'judged' };
          },
        }),
      }),
    } as unknown as BaseChatModel;
    return { judge, prompts };
  }

  function makeScenario(overrides: Partial<ToolCallScenario> = {}): ToolCallScenario {
    return {
      id: 'aw-005',
      name: 'Reminder is not a wake-up',
      purpose: 'p',
      input: 'Remind me in 10 minutes to call Sam.',
      type: 'tool-call',
      tool: '!schedule_wakeup',
      minScore: 1,
      responseRubric: 'Does not promise to remind the user later.',
      ...overrides,
    };
  }

  async function run(scenario: ToolCallScenario, model: BaseChatModel, judge: BaseChatModel) {
    const config: RunConfig = {
      ...makeRunConfig(),
      model,
      judgeModel: judge,
      tools: [fakeTool('schedule_wakeup'), fakeTool('ask_user')],
    };
    return executeScenario(scenario, makeSuite([scenario]), 'run-1', config, {
      count: 0,
      total: 0,
    });
  }

  it('passes when the forbidden tool is skipped and the reply is judged honest [unit]', async () => {
    const { judge } = makeRecordingJudge(9);
    const result = await run(
      makeScenario(),
      makeReplyingModel("I can't set reminders here yet."),
      judge,
    );

    assert.equal(result.passed, true);
    assert.equal(result.details.type, 'tool-call');
    if (result.details.type === 'tool-call') {
      assert.deepEqual(result.details.responseJudge, {
        score: 9,
        minScore: 7,
        reasoning: 'judged',
        judgeModel: 'test-model',
        biasRisk: true,
      });
    }
  });

  it('fails a false promise: the tool is skipped but the reply claims a reminder is set [unit]', async () => {
    const { judge } = makeRecordingJudge(2);
    const result = await run(
      makeScenario(),
      makeReplyingModel("Sure — I'll remind you in 10 minutes!"),
      judge,
    );

    assert.equal(result.passed, false);
    assert.equal(result.score, 0.2);
  });

  it('still fails when the forbidden tool is called, however well the reply is judged [unit]', async () => {
    const { judge } = makeRecordingJudge(10);
    const result = await run(
      makeScenario(),
      makeReplyingModel('Wake-up scheduled.', ['schedule_wakeup']),
      judge,
    );

    assert.equal(result.passed, false);
    assert.equal(result.score, 0);
  });

  it('gives the judge the user input, the reply text and the rubric [unit]', async () => {
    const { judge, prompts } = makeRecordingJudge(9);
    await run(makeScenario(), makeReplyingModel("I can't set reminders here yet."), judge);

    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /User input: Remind me in 10 minutes to call Sam\./);
    assert.match(prompts[0]!, /Actual output: I can't set reminders here yet\./);
    assert.match(prompts[0]!, /Rubric: Does not promise to remind the user later\./);
  });

  it('honors a custom responseMinScore [unit]', async () => {
    const { judge } = makeRecordingJudge(8);
    const result = await run(
      makeScenario({ responseMinScore: 9 }),
      makeReplyingModel("I can't set reminders here yet."),
      judge,
    );

    assert.equal(result.passed, false);
  });

  it('never calls the judge when no responseRubric is set [unit]', async () => {
    const result = await run(
      makeScenario({ responseRubric: undefined }),
      makeReplyingModel("Sure — I'll remind you!"),
      neverInvokedModel(),
    );

    assert.equal(result.passed, true);
    assert.equal(result.details.type === 'tool-call' && result.details.responseJudge, undefined);
  });
});

describe('executeScenario — tool-sequence responseRubric', () => {
  // A judge that records the prompt it was given and returns a fixed score.
  // Local copy mirroring the tool-call responseRubric block's own helper —
  // each describe block defines its own, same convention as makeScenario.
  function makeRecordingJudge(score: number): { judge: BaseChatModel; prompts: string[] } {
    const prompts: string[] = [];
    const judge = {
      withStructuredOutput: () => ({
        withRetry: () => ({
          invoke: async (prompt: string) => {
            prompts.push(prompt);
            return { score, reasoning: 'judged' };
          },
        }),
      }),
    } as unknown as BaseChatModel;
    return { judge, prompts };
  }

  function makeScenario(overrides: Partial<ToolSequenceScenario> = {}): ToolSequenceScenario {
    return {
      id: 'ts-rubric-1',
      name: 'Loop guard nudge compliance',
      purpose: 'p',
      type: 'tool-sequence',
      turns: [{ user: 'Find every place the literal string "Abort" appears in this repo.' }],
      tool: '!shell_exec',
      minScore: 1,
      responseRubric: 'Does not repeat the same stagnant search.',
      ...overrides,
    };
  }

  async function run(scenario: ToolSequenceScenario, model: BaseChatModel, judge: BaseChatModel) {
    const config: RunConfig = {
      ...makeRunConfig(),
      model,
      judgeModel: judge,
      tools: [fakeTool('shell_exec'), fakeTool('ls')],
    };
    return executeScenario(scenario, makeSuite([scenario]), 'run-1', config, {
      count: 0,
      total: 0,
    });
  }

  it('passes when the forbidden tool is skipped and the reply is judged honest [unit]', async () => {
    const { judge } = makeRecordingJudge(9);
    const result = await run(makeScenario(), makeReplyingModel('No matches found.'), judge);

    assert.equal(result.passed, true);
    assert.equal(result.details.type, 'tool-sequence');
    if (result.details.type === 'tool-sequence') {
      assert.deepEqual(result.details.responseJudge, {
        score: 9,
        minScore: 7,
        reasoning: 'judged',
        judgeModel: 'test-model',
        biasRisk: true,
      });
    }
  });

  it('fails a false promise: the tool is skipped but the reply is judged as not actually different [unit]', async () => {
    const { judge } = makeRecordingJudge(2);
    const result = await run(makeScenario(), makeReplyingModel('Still thinking it over.'), judge);

    assert.equal(result.passed, false);
    assert.equal(result.score, 0.2);
  });

  it('still fails when the forbidden tool is called, however well the reply is judged [unit]', async () => {
    const { judge } = makeRecordingJudge(10);
    const result = await run(
      makeScenario(),
      makeReplyingModel('Trying again.', ['shell_exec']),
      judge,
    );

    assert.equal(result.passed, false);
    assert.equal(result.score, 0);
  });

  it('gives the judge the scenario input, the reply text, the rubric, and the tool call(s) made this turn [unit]', async () => {
    const { judge, prompts } = makeRecordingJudge(9);
    await run(
      makeScenario(),
      makeReplyingModel('Listing the repo contents instead.', ['ls']),
      judge,
    );

    assert.equal(prompts.length, 1);
    assert.match(
      prompts[0]!,
      /User input: Find every place the literal string "Abort" appears in this repo\./,
    );
    assert.match(prompts[0]!, /Actual output: Listing the repo contents instead\./);
    assert.match(prompts[0]!, /Tool call\(s\) made this turn:\n1\. ls\(\{\}\)/);
    assert.match(prompts[0]!, /Rubric: Does not repeat the same stagnant search\./);
  });

  it('honors a custom responseMinScore [unit]', async () => {
    const { judge } = makeRecordingJudge(8);
    const result = await run(
      makeScenario({ responseMinScore: 9 }),
      makeReplyingModel('No matches found.'),
      judge,
    );

    assert.equal(result.passed, false);
  });

  it('never calls the judge when no responseRubric is set [unit]', async () => {
    const result = await run(
      makeScenario({ responseRubric: undefined }),
      makeReplyingModel('No matches found.'),
      neverInvokedModel(),
    );

    assert.equal(result.passed, true);
    assert.equal(
      result.details.type === 'tool-sequence' && result.details.responseJudge,
      undefined,
    );
  });
});

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
      turns: [
        { user: 'confirm?' },
        { tool: 'ask_user', args: { question: 'confirm?' }, result: { text: 'yes' } },
        { user: 'Yes, that looks right.' },
      ],
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

// Issue #227: a model/provider pairing can emit a tool call as plain text
// instead of populating AIMessage.tool_calls, or answer an ask_user-worthy
// clarification in prose instead of calling ask_user. Both currently looked
// identical to "the model declined to act" — these tests confirm the
// detector's output is correctly attached to the result and, for a negated
// scenario, correctly flips what would otherwise be a false pass.
describe('executeScenario — malformed tool call / prose question detection (issue #227)', () => {
  function makeToolCallScenario(overrides: Partial<ToolCallScenario> = {}): ToolCallScenario {
    return {
      id: 'mtc-tc-1',
      name: 'Malformed tool call tool-call scenario',
      purpose: 'Testing',
      type: 'tool-call',
      input: 'Search the knowledge base for coffee.',
      tool: 'wiki_search',
      minScore: 1,
      ...overrides,
    };
  }

  function makeToolSequenceScenario(
    overrides: Partial<ToolSequenceScenario> = {},
  ): ToolSequenceScenario {
    return {
      id: 'mtc-ts-1',
      name: 'Malformed tool call tool-sequence scenario',
      purpose: 'Testing',
      type: 'tool-sequence',
      turns: [
        { user: 'Locate the right domain, then search it for coffee.' },
        { tool: 'wiki_locate', args: {}, result: { text: 'Matched domain: user.' } },
        { user: 'Great, now search that domain for coffee.' },
      ],
      tool: 'wiki_search',
      minScore: 1,
      ...overrides,
    };
  }

  it('tool-call: annotates malformedToolCall when the model emits the call as text [unit]', async () => {
    const scenario = makeToolCallScenario();
    const config: RunConfig = {
      ...makeRunConfig(),
      model: makeReplyingModel(
        '<tool_call><function=wiki_search>{"query": "coffee"}</function></tool_call>',
      ),
      tools: [fakeTool('wiki_search')],
    };

    const result = await executeScenario(scenario, makeSuite([scenario]), 'run-1', config, {
      count: 0,
      total: 0,
    });

    assert.equal(result.passed, false);
    assert.equal(result.details.type, 'tool-call');
    if (result.details.type === 'tool-call') {
      assert.deepEqual(result.details.malformedToolCall?.parsedToolName, 'wiki_search');
    }
  });

  it('tool-call: negated scenario fails (not a false pass) when the forbidden tool appears as text [unit]', async () => {
    const scenario = makeToolCallScenario({ tool: '!schedule_wakeup' });
    const config: RunConfig = {
      ...makeRunConfig(),
      model: makeReplyingModel('<function=schedule_wakeup>{"delaySeconds": 600}'),
      tools: [fakeTool('schedule_wakeup')],
    };

    const result = await executeScenario(scenario, makeSuite([scenario]), 'run-1', config, {
      count: 0,
      total: 0,
    });

    assert.equal(result.passed, false);
    assert.equal(result.score, 0);
    assert.equal(result.details.type, 'tool-call');
    if (result.details.type === 'tool-call') {
      assert.equal(result.details.malformedToolCall?.parsedToolName, 'schedule_wakeup');
    }
  });

  it('tool-call: annotates proseQuestion when ask_user is expected but the model asks in plain text [unit]', async () => {
    const scenario = makeToolCallScenario({ tool: 'ask_user' });
    const config: RunConfig = {
      ...makeRunConfig(),
      model: makeReplyingModel('Did you mean the personal domain or the work domain?'),
      tools: [fakeTool('ask_user')],
    };

    const result = await executeScenario(scenario, makeSuite([scenario]), 'run-1', config, {
      count: 0,
      total: 0,
    });

    assert.equal(result.details.type, 'tool-call');
    if (result.details.type === 'tool-call') {
      assert.equal(
        result.details.proseQuestion?.raw,
        'Did you mean the personal domain or the work domain?',
      );
    }
  });

  it('tool-call: does not false-positive on ordinary prose with zero tool calls [unit]', async () => {
    const scenario = makeToolCallScenario();
    const config: RunConfig = {
      ...makeRunConfig(),
      model: makeReplyingModel('I was not able to find anything about that.'),
      tools: [fakeTool('wiki_search')],
    };

    const result = await executeScenario(scenario, makeSuite([scenario]), 'run-1', config, {
      count: 0,
      total: 0,
    });

    assert.equal(result.details.type, 'tool-call');
    if (result.details.type === 'tool-call') {
      assert.equal(result.details.malformedToolCall, undefined);
      assert.equal(result.details.proseQuestion, undefined);
    }
  });

  it('llm-judge: annotates malformedToolCall alongside the normal judge score/reasoning [unit]', async () => {
    const scenario: LlmJudgeScenario = {
      id: 'mtc-judge-1',
      name: 'Malformed tool call llm-judge scenario',
      purpose: 'Testing',
      type: 'llm-judge',
      input: 'Search the knowledge base for coffee.',
      rubric: 'Does the reply answer the question?',
      minScore: 7,
    };
    const { model } = makeCapturingModel(
      '<tool_call>{"name": "wiki_search", "arguments": {"query": "coffee"}}</tool_call>',
    );
    const config: RunConfig = {
      ...makeRunConfig(),
      model,
      judgeModel: makeFakeJudgeModel(2, 'The reply was a raw tool call block, not an answer.'),
      tools: [fakeTool('wiki_search')],
    };

    const result = await executeScenario(scenario, makeSuite([scenario]), 'run-1', config, {
      count: 0,
      total: 0,
    });

    assert.equal(result.details.type, 'llm-judge');
    if (result.details.type === 'llm-judge') {
      assert.equal(result.details.malformedToolCall?.parsedToolName, 'wiki_search');
      assert.equal(result.details.score, 2);
      assert.equal(result.details.reasoning, 'The reply was a raw tool call block, not an answer.');
    }
  });

  it('tool-sequence: annotates malformedToolCall when the model emits the call as text [unit]', async () => {
    const scenario = makeToolSequenceScenario();
    const config: RunConfig = {
      ...makeRunConfig(),
      model: makeReplyingModel(
        '<tool_call><function=wiki_search>{"query": "coffee"}</function></tool_call>',
      ),
      tools: [fakeTool('wiki_search'), fakeTool('wiki_locate')],
    };

    const result = await executeScenario(scenario, makeSuite([scenario]), 'run-1', config, {
      count: 0,
      total: 0,
    });

    assert.equal(result.passed, false);
    assert.equal(result.details.type, 'tool-sequence');
    if (result.details.type === 'tool-sequence') {
      assert.equal(result.details.malformedToolCall?.parsedToolName, 'wiki_search');
    }
  });

  it('tool-sequence: negated scenario fails (not a false pass) when the forbidden tool appears as text [unit]', async () => {
    const scenario = makeToolSequenceScenario({ tool: '!schedule_wakeup' });
    const config: RunConfig = {
      ...makeRunConfig(),
      model: makeReplyingModel('<function=schedule_wakeup>{"delaySeconds": 600}'),
      tools: [fakeTool('schedule_wakeup'), fakeTool('wiki_locate')],
    };

    const result = await executeScenario(scenario, makeSuite([scenario]), 'run-1', config, {
      count: 0,
      total: 0,
    });

    assert.equal(result.passed, false);
    assert.equal(result.score, 0);
    assert.equal(result.details.type, 'tool-sequence');
    if (result.details.type === 'tool-sequence') {
      assert.equal(result.details.malformedToolCall?.parsedToolName, 'schedule_wakeup');
    }
  });
});

// Issue #154: config.filterHarnessSections lets a caller (bin/eval.ts, using
// the real api/src/agents/system-prompt.ts implementation) gate tool-scoped
// system-prompt content on a scenario's actual bound-tool set, without this
// package importing anything from api — see RunConfig's own doc comment.
// These tests use a trivial fake filter rather than the real one, since this
// package has no dependency on api/src/agents/system-prompt.ts.
describe('executeScenario — filterHarnessSections (issue #154)', () => {
  function makeToolCallScenario(overrides: Partial<ToolCallScenario> = {}): ToolCallScenario {
    return {
      id: 'filter-tc-1',
      name: 'Filter tool-call scenario',
      purpose: 'Testing',
      type: 'tool-call',
      input: 'do something',
      tool: 'web_fetch',
      minScore: 1,
      ...overrides,
    };
  }

  it("passes the scenario's actual bound-tool set (post-excludeTools) to the callback and uses its result", async () => {
    const scenario = makeToolCallScenario({ excludeTools: ['shell_exec'] });
    const suite = makeSuite([scenario]);
    const { model, getLastInput } = makeCapturingBindToolsModel('web_fetch');
    let capturedIds: Set<string> | undefined;
    const config: RunConfig = {
      ...makeRunConfig(),
      model,
      tools: [fakeTool('web_fetch'), fakeTool('shell_exec')],
      systemPrompt: 'BASE PROMPT',
      filterHarnessSections: (prompt, ids) => {
        capturedIds = ids;
        return `${prompt} (filtered)`;
      },
    };

    await executeScenario(scenario, suite, 'run-1', config, { count: 0, total: 0 });

    assert.deepEqual([...(capturedIds ?? [])], ['web_fetch']);
    const input = getLastInput() as SystemMessage[];
    assert.equal(input[0]!.content, 'BASE PROMPT (filtered)');
  });

  it('leaves config.systemPrompt unfiltered when filterHarnessSections is not provided', async () => {
    const scenario = makeToolCallScenario();
    const suite = makeSuite([scenario]);
    const { model, getLastInput } = makeCapturingBindToolsModel('web_fetch');
    const config: RunConfig = {
      ...makeRunConfig(),
      model,
      tools: [fakeTool('web_fetch')],
      systemPrompt: 'BASE PROMPT',
    };

    await executeScenario(scenario, suite, 'run-1', config, { count: 0, total: 0 });

    const input = getLastInput() as SystemMessage[];
    assert.equal(input[0]!.content, 'BASE PROMPT');
  });
});

// Explicit #tool-name syntax (issue #172) — same split as filterHarnessSections
// above: extractRequestedToolIds/buildRequiredToolBlocks are the real
// api/src/agents/tool-syntax.ts implementations in production, injected here
// as trivial fakes since this package has no dependency on api.
describe('executeScenario — required-tool injection (issue #172)', () => {
  function makeToolCallScenario(overrides: Partial<ToolCallScenario> = {}): ToolCallScenario {
    return {
      id: 'reqtool-tc-1',
      name: 'Required-tool scenario',
      purpose: 'Testing',
      type: 'tool-call',
      input: '#web_fetch do something',
      tool: 'web_fetch',
      minScore: 1,
      ...overrides,
    };
  }

  it("detects a #token in the scenario's input and appends a required-tool block", async () => {
    const scenario = makeToolCallScenario();
    const suite = makeSuite([scenario]);
    const { model, getLastInput } = makeCapturingBindToolsModel('web_fetch');
    const config: RunConfig = {
      ...makeRunConfig(),
      model,
      tools: [fakeTool('web_fetch')],
      systemPrompt: 'BASE PROMPT',
      extractRequestedToolIds: (content) => {
        const m = content.match(/#([a-z_]+)/);
        return m ? [m[1]!] : [];
      },
      buildRequiredToolBlocks: (ids, available) =>
        ids.filter((id) => available.has(id)).map((id) => `<required-tool id="${id}"/>`),
    };

    await executeScenario(scenario, suite, 'run-1', config, { count: 0, total: 0 });

    const input = getLastInput() as SystemMessage[];
    assert.equal(input[0]!.content, 'BASE PROMPT\n\n<required-tool id="web_fetch"/>');
  });

  it('passes the actual bound-tool set (post-excludeTools) to buildRequiredToolBlocks', async () => {
    const scenario = makeToolCallScenario({ excludeTools: ['web_fetch'] });
    const suite = makeSuite([scenario]);
    const { model, getLastInput } = makeCapturingBindToolsModel('shell_exec');
    let capturedIds: Set<string> | undefined;
    const config: RunConfig = {
      ...makeRunConfig(),
      model,
      tools: [fakeTool('web_fetch'), fakeTool('shell_exec')],
      systemPrompt: 'BASE PROMPT',
      extractRequestedToolIds: () => ['web_fetch'],
      buildRequiredToolBlocks: (ids, available) => {
        capturedIds = available;
        return ids.filter((id) => available.has(id)).map((id) => `<required-tool id="${id}"/>`);
      },
    };

    await executeScenario(scenario, suite, 'run-1', config, { count: 0, total: 0 });

    assert.deepEqual([...(capturedIds ?? [])], ['shell_exec']);
    const input = getLastInput() as SystemMessage[];
    // web_fetch was excluded from this scenario's bound tools, so even
    // though the #token requested it, no block should be appended.
    assert.equal(input[0]!.content, 'BASE PROMPT');
  });

  it('leaves config.systemPrompt unchanged when neither callback is provided', async () => {
    const scenario = makeToolCallScenario();
    const suite = makeSuite([scenario]);
    const { model, getLastInput } = makeCapturingBindToolsModel('web_fetch');
    const config: RunConfig = {
      ...makeRunConfig(),
      model,
      tools: [fakeTool('web_fetch')],
      systemPrompt: 'BASE PROMPT',
    };

    await executeScenario(scenario, suite, 'run-1', config, { count: 0, total: 0 });

    const input = getLastInput() as SystemMessage[];
    assert.equal(input[0]!.content, 'BASE PROMPT');
  });

  it('composes with filterHarnessSections in the same call', async () => {
    const scenario = makeToolCallScenario();
    const suite = makeSuite([scenario]);
    const { model, getLastInput } = makeCapturingBindToolsModel('web_fetch');
    const config: RunConfig = {
      ...makeRunConfig(),
      model,
      tools: [fakeTool('web_fetch')],
      systemPrompt: 'BASE PROMPT',
      filterHarnessSections: (prompt) => `${prompt} (filtered)`,
      extractRequestedToolIds: () => ['web_fetch'],
      buildRequiredToolBlocks: (ids) => ids.map((id) => `<required-tool id="${id}"/>`),
    };

    await executeScenario(scenario, suite, 'run-1', config, { count: 0, total: 0 });

    const input = getLastInput() as SystemMessage[];
    assert.equal(input[0]!.content, 'BASE PROMPT (filtered)\n\n<required-tool id="web_fetch"/>');
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
    assert.equal(run.scoredScenarios, 1);
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
    assert.equal(run.scoredScenarios, 1);
    assert.equal(run.passedScenarios, 0);
    assert.equal(run.passRate, 0);
  });

  it('a skipped human scenario reduces scoredScenarios but not totalScenarios', () => {
    const results: ScenarioResult[] = [
      makeResult({ scenarioId: 'sc-pass', passed: true }),
      makeResult({ scenarioId: 'sc-pass-2', passed: true }),
      makeResult({
        scenarioId: 'sc-human-pending',
        passed: false,
        score: null,
        details: { type: 'human', status: 'pending' },
      }),
    ];
    const suite = makeSuite([]);
    const run = computeRunSummary(results, suite, 'run-1', 'model-a', 'model-a', '2026-01-01');
    assert.equal(run.totalScenarios, 3);
    assert.equal(run.scoredScenarios, 2);
    assert.equal(run.passedScenarios, 2);
    assert.equal(run.passRate, 1); // 2/2 scored, not 2/3 total
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

  describe('getScoredScenarios', () => {
    it('returns scoredScenarios when present', () => {
      const suite = makeSuite([]);
      const run = computeRunSummary(
        [makeResult({ scenarioId: 'sc-1', passed: true })],
        suite,
        'run-1',
        'model-a',
        'model-a',
        '2026-01-01',
      );
      assert.equal(getScoredScenarios(run), run.scoredScenarios);
    });

    it('falls back to totalScenarios for a result without scoredScenarios (pre-existing YAML/DB data)', () => {
      const legacyRun: EvalRun = {
        id: 'run-1',
        suiteId: 'test-suite',
        model: 'model-a',
        startedAt: '2026-01-01',
        passed: true,
        passRate: 1,
        totalScenarios: 3,
        passedScenarios: 3,
        totalLatencyMs: 0,
        estimatedCostUsd: 0,
      };
      assert.equal(getScoredScenarios(legacyRun), 3);
    });
  });
});

// A tools-bound model that returns a different canned response on each
// successive invoke() call — needed for the multi-step (`steps`) tests
// below, where the model must respond differently at each step (first a
// tool call, then a plain text answer) rather than the same thing every
// time (unlike makeReplyingModel/makeCapturingBindToolsModel above).
function makeSequencedBindToolsModel(
  responses: Array<{
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
    content: string;
  }>,
): { model: BaseChatModel; getInputs: () => unknown[] } {
  let i = 0;
  const inputs: unknown[] = [];
  const model = {
    bindTools: () => ({
      invoke: async (input: unknown) => {
        inputs.push(input);
        const next = responses[i] ?? responses[responses.length - 1]!;
        i++;
        return {
          tool_calls: (next.toolCalls ?? []).map((c, idx) => ({
            id: `seq-${idx}`,
            name: c.name,
            args: c.args,
          })),
          content: next.content,
        };
      },
    }),
  } as unknown as BaseChatModel;
  return { model, getInputs: () => inputs };
}

describe('executeScenario — turns ordering regression (issue #235)', () => {
  it('invokes the model with the reply after the tool turn it answers, not before', async () => {
    const scenario: ToolSequenceScenario = {
      id: 'cwp-006-regression',
      name: 'Confirms before creating a project',
      purpose: 'p',
      type: 'tool-sequence',
      turns: [
        { user: 'Create a project "Ship Homepage Redesign".' },
        {
          tool: 'ask_user',
          args: { question: 'Create project "Ship Homepage Redesign"?' },
          result: { text: 'User answered: yes' },
        },
        { user: 'Yep, go ahead.' },
      ],
      tool: 'create_project',
      minScore: 1,
    };
    const suite = makeSuite([scenario]);
    const { model, getLastInput } = makeCapturingBindToolsModel('create_project');
    const config: RunConfig = { ...makeRunConfig(), model, tools: [fakeTool('create_project')] };

    await executeScenario(scenario, suite, 'run-1', config, { count: 0, total: 0 });

    const input = getLastInput() as unknown[];
    assert.ok(Array.isArray(input));
    assert.equal(input.length, 4);
    assert.ok(input[0] instanceof HumanMessage);
    assert.equal((input[0] as HumanMessage).content, 'Create a project "Ship Homepage Redesign".');
    assert.ok(input[1] instanceof AIMessage);
    assert.ok(input[2] instanceof ToolMessage);
    // The reply is the LAST message the model actually sees — the bug
    // #235 fixed put it first instead.
    assert.ok(input[3] instanceof HumanMessage);
    assert.equal((input[3] as HumanMessage).content, 'Yep, go ahead.');
  });
});

describe('executeScenario — steps (issue #235 (b), multi-step conversations)', () => {
  it('deterministic: scores an intermediate step with its own assert, then the final step with the top-level fields', async () => {
    const scenario: DeterministicScenario = {
      id: 'multi-det-1',
      name: 'Multi-step deterministic',
      purpose: 'p',
      type: 'deterministic',
      match: 'contains',
      expected: 'final answer',
      steps: [
        { user: 'first question', assert: { match: 'contains', expected: 'intermediate answer' } },
        { user: 'second question' },
      ],
    };
    const suite = makeSuite([scenario]);
    let call = 0;
    const model = {
      invoke: async () => {
        call++;
        return { content: call === 1 ? 'intermediate answer here' : 'the final answer is this' };
      },
    } as unknown as BaseChatModel;
    const config: RunConfig = { ...makeRunConfig(), model };

    const result = await executeScenario(scenario, suite, 'run-1', config, { count: 0, total: 0 });

    assert.equal(result.passed, true);
    assert.equal(result.actualOutput, 'the final answer is this');
    assert.ok(result.details.type === 'deterministic');
    if (result.details.type === 'deterministic') {
      assert.equal(result.details.steps?.length, 1);
      assert.equal(result.details.steps?.[0]?.passed, true);
      assert.equal(result.details.steps?.[0]?.index, 0);
    }
    // conversation carries both steps' turns plus both responses.
    assert.equal(result.conversation?.length, 4);
  });

  it('deterministic: an intermediate step failing its assert fails the whole scenario, but the final step still runs', async () => {
    const scenario: DeterministicScenario = {
      id: 'multi-det-2',
      name: 'Multi-step deterministic, failing intermediate',
      purpose: 'p',
      type: 'deterministic',
      match: 'contains',
      expected: 'final answer',
      steps: [
        { user: 'first question', assert: { match: 'contains', expected: 'never appears' } },
        { user: 'second question' },
      ],
    };
    const suite = makeSuite([scenario]);
    const model = {
      invoke: async () => ({ content: 'the final answer is this' }),
    } as unknown as BaseChatModel;
    const config: RunConfig = { ...makeRunConfig(), model };

    const result = await executeScenario(scenario, suite, 'run-1', config, { count: 0, total: 0 });

    // Continue-on-failure (issue #235's resolved design question): the
    // final step still ran and still matched, but the overall scenario
    // fails because the intermediate step's assert didn't.
    assert.equal(result.passed, false);
    assert.ok(result.details.type === 'deterministic');
    if (result.details.type === 'deterministic') {
      assert.equal(result.details.passed, true); // final-step assertion alone
      assert.equal(result.details.steps?.[0]?.passed, false);
    }
  });

  it('tool-sequence: feeds a mocked tool result back so the conversation can continue past an intermediate tool call', async () => {
    const scenario: ToolSequenceScenario = {
      id: 'multi-ts-1',
      name: 'Multi-step tool-sequence with a mocked intermediate tool call',
      purpose: 'p',
      type: 'tool-sequence',
      steps: [
        {
          user: 'find the engineering wiki',
          mocks: { wiki_locate: { text: 'Matched domain: engineering.' } },
        },
        { user: 'now search it for "deploy"' },
      ],
      tool: 'wiki_search',
      minScore: 1,
    };
    const suite = makeSuite([scenario]);
    const { model, getInputs } = makeSequencedBindToolsModel([
      { toolCalls: [{ name: 'wiki_locate', args: {} }], content: '' },
      { toolCalls: [{ name: 'wiki_search', args: { query: 'deploy' } }], content: '' },
    ]);
    const config: RunConfig = {
      ...makeRunConfig(),
      model,
      tools: [fakeTool('wiki_search'), fakeTool('wiki_locate')],
    };

    const result = await executeScenario(scenario, suite, 'run-1', config, { count: 0, total: 0 });

    assert.equal(result.passed, true);
    assert.ok(result.details.type === 'tool-sequence');
    if (result.details.type === 'tool-sequence') {
      assert.equal(result.details.toolCalled, 'wiki_search');
    }
    // Second invocation's messages must include a ToolMessage synthesized
    // from the mock, standing in for wiki_locate's real result.
    const secondCallMessages = getInputs()[1] as unknown[];
    assert.ok(secondCallMessages.some((m) => m instanceof ToolMessage));
  });

  it('tool-sequence: throws when an intermediate step calls a tool with no matching mock', async () => {
    const scenario: ToolSequenceScenario = {
      id: 'multi-ts-2',
      name: 'Multi-step tool-sequence with an unmocked intermediate tool call',
      purpose: 'p',
      type: 'tool-sequence',
      steps: [{ user: 'find the engineering wiki' }, { user: 'now search it for "deploy"' }],
      tool: 'wiki_search',
      minScore: 1,
    };
    const suite = makeSuite([scenario]);
    const { model } = makeSequencedBindToolsModel([
      { toolCalls: [{ name: 'wiki_locate', args: {} }], content: '' },
      { toolCalls: [{ name: 'wiki_search', args: { query: 'deploy' } }], content: '' },
    ]);
    const config: RunConfig = {
      ...makeRunConfig(),
      model,
      tools: [fakeTool('wiki_search'), fakeTool('wiki_locate')],
    };

    // executeScenario's own try/catch turns this into a failed result
    // rather than propagating — assert on that, matching how every other
    // scenario-execution error already behaves (see the catch block at the
    // bottom of executeScenario).
    const result = await executeScenario(scenario, suite, 'run-1', config, { count: 0, total: 0 });
    assert.equal(result.passed, false);
    assert.match(result.actualOutput, /no mocks\["wiki_locate"\] entry/);
  });
});

describe('migration equivalence (issue #235) — turns produces the same messages buildSeededMessages used to', () => {
  it('a correctly-ordered migrated scenario (input first, then its old priorTurns) is unaffected', () => {
    // This is exactly what the migration script does to every scenario
    // NOT on issue #235's affected list: `input` becomes the first `user`
    // entry, followed by the old `priorTurns`, unchanged and in order.
    const migrated = buildTurnMessages([
      { user: 'Please save this to my wiki: the deploy runbook is in #ops.' },
      { tool: 'wiki_search', args: { query: 'ops' }, result: { text: 'no existing page' } },
    ]);

    assert.equal(migrated.length, 3);
    assert.ok(migrated[0] instanceof HumanMessage);
    assert.equal(
      migrated[0].content,
      'Please save this to my wiki: the deploy runbook is in #ops.',
    );
    assert.ok(migrated[1] instanceof AIMessage);
    assert.ok(migrated[2] instanceof ToolMessage);
  });
});
