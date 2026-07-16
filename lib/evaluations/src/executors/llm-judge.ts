import { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { LlmJudgeScenario } from '../schemas.js';

const JudgeResponseSchema = z.object({
  score: z.number().min(0).max(10),
  reasoning: z.string(),
});

interface LlmJudgeDetails {
  type: 'llm-judge';
  score: number;
  reasoning: string;
  judgeModel: string;
  biasRisk: boolean;
}

export async function runLlmJudge(
  scenario: LlmJudgeScenario,
  actualOutput: string,
  modelId: string,
  judgeModel: BaseChatModel,
  judgeModelId: string,
): Promise<LlmJudgeDetails> {
  const prompt = [
    'You are evaluating an AI response against a rubric. Return a JSON object with "score" (integer 0-10) and "reasoning" (string).',
    '',
    `User input: ${scenario.input}`,
    '',
    `Actual output: ${actualOutput}`,
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
