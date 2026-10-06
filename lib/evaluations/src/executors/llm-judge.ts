import { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { LlmJudgeScenario } from '../schemas.js';
import type { InvokedToolCall } from './tool-call.js';

// No .min()/.max() on score: those compile to JSON Schema minimum/maximum,
// which Anthropic's structured-output/tool-use schema validation rejects
// outright (400: "For 'number' type, properties maximum, minimum are not
// supported") — unlike the OpenAI-compatible endpoints every other provider
// in this harness talks over, which accept it fine. The prompt below
// already instructs "integer 0-10" in plain text, so the range is still
// communicated — just not provider-enforced via schema.
const JudgeResponseSchema = z.object({
  score: z.number(),
  reasoning: z.string(),
});

interface LlmJudgeDetails {
  type: 'llm-judge';
  score: number;
  reasoning: string;
  judgeModel: string;
  biasRisk: boolean;
}

// Only the input and rubric are read, so a tool-call/tool-sequence
// scenario's responseRubric can be judged with the same prompt (see
// runner.ts). The optional `toolCalls` param additionally lets the judge
// see the substance of a tool call made that same turn (name + args), not
// just surrounding prose — omitted/empty leaves the prompt byte-for-byte
// identical to before this param existed, so it's safe for any caller
// that doesn't pass it (see runner.ts's tool-call branch, which
// deliberately never does, to protect its existing responseRubric
// baselines — see issue #266 / PR #269's eval-harness follow-up).
export async function runLlmJudge(
  scenario: Pick<LlmJudgeScenario, 'input' | 'rubric'>,
  actualOutput: string,
  modelId: string,
  judgeModel: BaseChatModel,
  judgeModelId: string,
  toolCalls?: InvokedToolCall[],
): Promise<LlmJudgeDetails> {
  const prompt = [
    'You are evaluating an AI response against a rubric. Return a JSON object with "score" (integer 0-10) and "reasoning" (string).',
    '',
    `User input: ${scenario.input}`,
    '',
    `Actual output: ${actualOutput}`,
    ...(toolCalls && toolCalls.length > 0
      ? [
          '',
          'Tool call(s) made this turn:',
          ...toolCalls.map((c, i) => `${i + 1}. ${c.name}(${JSON.stringify(c.args)})`),
        ]
      : []),
    '',
    `Rubric: ${scenario.rubric}`,
    '',
    'Respond only with valid JSON.',
  ].join('\n');

  let structured: z.infer<typeof JudgeResponseSchema>;
  try {
    const chain = judgeModel
      .withStructuredOutput(JudgeResponseSchema)
      .withRetry({ stopAfterAttempt: 3 });
    structured = await chain.invoke(prompt);
  } catch (err) {
    throw new Error(
      `Judge model "${judgeModelId}" does not support structured output or failed to respond after retries: ${String(err)}`,
    );
  }

  return {
    type: 'llm-judge',
    score: structured.score,
    reasoning: structured.reasoning,
    judgeModel: judgeModelId,
    biasRisk: judgeModelId === modelId,
  };
}
