import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';
import type { Message } from '@tkottke90/inference-adapter';
import { LangChainInferenceAdapter } from './rlm-adapter.js';

// A fake BaseChatModel satisfying only the .withStructuredOutput().invoke()
// chain LangChainInferenceAdapter.invoke()'s options.schema branch actually
// calls — same hand-rolled-fake pattern as after-agent.test.ts's
// fakeStructuredLlm (no mocking library in this repo's toolchain). Records
// withStructuredOutput's own arguments so the test can assert the
// method: 'jsonSchema' override reaches the model, not just that some
// structured result comes back.
function fakeStructuredModel(result: unknown) {
  const structuredOutputCalls: unknown[][] = [];
  const model = {
    withStructuredOutput(...args: unknown[]) {
      structuredOutputCalls.push(args);
      return {
        async invoke() {
          return result;
        },
      };
    },
  };
  return { model: model as unknown as BaseChatModel, structuredOutputCalls };
}

describe('services/rlm-adapter', () => {
  describe('LangChainInferenceAdapter.invoke() — structured output', () => {
    it('calls withStructuredOutput(schema, { method: "jsonSchema" }) and returns the result as InferenceResponse.structured', async () => {
      const schema = z.object({ answer: z.string() });
      const fakeResult = { answer: 'because the sky scatters blue light' };
      const { model, structuredOutputCalls } = fakeStructuredModel(fakeResult);

      const adapter = new LangChainInferenceAdapter(model);
      const messages: Message[] = [{ role: 'user', content: 'why is the sky blue?' }];

      const response = await adapter.invoke(messages, { schema });

      expect(structuredOutputCalls).to.deep.equal([[schema, { method: 'jsonSchema' }]]);
      expect(response.structured).to.deep.equal(fakeResult);
    });
  });
});
