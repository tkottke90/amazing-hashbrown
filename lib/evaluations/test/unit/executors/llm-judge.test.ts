import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { runLlmJudge } from '../../../src/executors/llm-judge.js';

// Mirrors runner.test.ts's makeFakeJudgeModel pattern — supports the exact
// chain runLlmJudge drives: judgeModel.withStructuredOutput(schema)
// .withRetry(opts).invoke(prompt). Records every prompt sent so tests can
// assert on prompt construction.
function makeRecordingJudgeModel(respond: () => Promise<{ score: number; reasoning: string }>): {
  model: BaseChatModel;
  prompts: string[];
} {
  const prompts: string[] = [];
  const model = {
    withStructuredOutput: () => ({
      withRetry: () => ({
        invoke: async (prompt: string) => {
          prompts.push(prompt);
          return respond();
        },
      }),
    }),
  } as unknown as BaseChatModel;
  return { model, prompts };
}

describe('runLlmJudge', () => {
  describe('prompt construction', () => {
    it('includes the input, actual output, and rubric [unit]', async () => {
      const { model, prompts } = makeRecordingJudgeModel(async () => ({
        score: 8,
        reasoning: 'ok',
      }));
      await runLlmJudge(
        { input: 'the question', rubric: 'the rubric' },
        'the answer',
        'm',
        model,
        'judge-m',
      );
      assert.match(prompts[0]!, /User input: the question/);
      assert.match(prompts[0]!, /Actual output: the answer/);
      assert.match(prompts[0]!, /Rubric: the rubric/);
    });

    it('omits the toolCalls section when toolCalls is not passed [unit]', async () => {
      const { model, prompts } = makeRecordingJudgeModel(async () => ({
        score: 8,
        reasoning: 'ok',
      }));
      await runLlmJudge({ input: 'q', rubric: 'r' }, 'a', 'm', model, 'judge-m');
      assert.doesNotMatch(prompts[0]!, /Tool call\(s\)/);
    });

    it('omits the toolCalls section when toolCalls is an empty array [unit]', async () => {
      const { model, prompts } = makeRecordingJudgeModel(async () => ({
        score: 8,
        reasoning: 'ok',
      }));
      await runLlmJudge({ input: 'q', rubric: 'r' }, 'a', 'm', model, 'judge-m', []);
      assert.doesNotMatch(prompts[0]!, /Tool call\(s\)/);
    });

    it('produces a byte-identical prompt whether toolCalls is omitted or an empty array [unit]', async () => {
      const a = makeRecordingJudgeModel(async () => ({ score: 8, reasoning: 'ok' }));
      const b = makeRecordingJudgeModel(async () => ({ score: 8, reasoning: 'ok' }));
      await runLlmJudge({ input: 'q', rubric: 'r' }, 'a', 'm', a.model, 'judge-m');
      await runLlmJudge({ input: 'q', rubric: 'r' }, 'a', 'm', b.model, 'judge-m', []);
      assert.equal(a.prompts[0], b.prompts[0]);
    });

    it('includes a numbered toolCalls section when toolCalls is non-empty [unit]', async () => {
      const { model, prompts } = makeRecordingJudgeModel(async () => ({
        score: 8,
        reasoning: 'ok',
      }));
      await runLlmJudge({ input: 'q', rubric: 'r' }, 'a', 'm', model, 'judge-m', [
        { name: 'wiki_search', args: { query: 'x' } },
      ]);
      assert.match(
        prompts[0]!,
        /Tool call\(s\) made this turn:\n1\. wiki_search\(\{"query":"x"\}\)/,
      );
    });

    it('numbers multiple tool calls in order [unit]', async () => {
      const { model, prompts } = makeRecordingJudgeModel(async () => ({
        score: 8,
        reasoning: 'ok',
      }));
      await runLlmJudge({ input: 'q', rubric: 'r' }, 'a', 'm', model, 'judge-m', [
        { name: 'tool_a', args: {} },
        { name: 'tool_b', args: { x: 1 } },
      ]);
      assert.match(prompts[0]!, /1\. tool_a\(\{\}\)\n2\. tool_b\(\{"x":1\}\)/);
    });
  });

  describe('returned details', () => {
    it('passes score/reasoning through unchanged [unit]', async () => {
      const { model } = makeRecordingJudgeModel(async () => ({ score: 6, reasoning: 'because' }));
      const result = await runLlmJudge({ input: 'q', rubric: 'r' }, 'a', 'm', model, 'judge-m');
      assert.equal(result.score, 6);
      assert.equal(result.reasoning, 'because');
      assert.equal(result.type, 'llm-judge');
    });

    it('sets judgeModel to judgeModelId [unit]', async () => {
      const { model } = makeRecordingJudgeModel(async () => ({ score: 6, reasoning: 'x' }));
      const result = await runLlmJudge(
        { input: 'q', rubric: 'r' },
        'a',
        'test-model',
        model,
        'judge-model-id',
      );
      assert.equal(result.judgeModel, 'judge-model-id');
    });

    it('sets biasRisk true when judgeModelId equals modelId [unit]', async () => {
      const { model } = makeRecordingJudgeModel(async () => ({ score: 6, reasoning: 'x' }));
      const result = await runLlmJudge(
        { input: 'q', rubric: 'r' },
        'a',
        'same-model',
        model,
        'same-model',
      );
      assert.equal(result.biasRisk, true);
    });

    it('sets biasRisk false when judgeModelId differs from modelId [unit]', async () => {
      const { model } = makeRecordingJudgeModel(async () => ({ score: 6, reasoning: 'x' }));
      const result = await runLlmJudge(
        { input: 'q', rubric: 'r' },
        'a',
        'model-a',
        model,
        'model-b',
      );
      assert.equal(result.biasRisk, false);
    });
  });

  describe('error path', () => {
    it('wraps a judge-model failure in an error naming the judge model id [unit]', async () => {
      const { model } = makeRecordingJudgeModel(async () => {
        throw new Error('structured output exhausted retries');
      });
      await assert.rejects(
        () => runLlmJudge({ input: 'q', rubric: 'r' }, 'a', 'm', model, 'judge-model-id'),
        /judge-model-id/,
      );
    });
  });
});
