import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { LLMResult } from '@langchain/core/outputs';
import type { Serialized } from '@langchain/core/load/serializable';
import type { ObservabilityStore, SpanRecord } from '@tkottke90/observability';
import { ObservabilityCallbackHandler } from './observability-handler.js';

function fakeStore(): { store: ObservabilityStore; calls: SpanRecord[][] } {
  const calls: SpanRecord[][] = [];
  const store = {
    saveSpans: (spans: SpanRecord[]) => {
      calls.push([...spans]);
    },
  } as unknown as ObservabilityStore;
  return { store, calls };
}

const llmResult: LLMResult = {
  generations: [[{ text: 'hello', message: { tool_calls: [] } } as never]],
  llmOutput: {},
};

describe('agents/observability-handler', () => {
  describe('ObservabilityCallbackHandler', () => {
    it('clears the completed-span buffer after each handleChainEnd save (no re-saving old spans)', async () => {
      const { store, calls } = fakeStore();
      const handler = new ObservabilityCallbackHandler('trace-1', store, 500);

      await handler.handleLLMStart({ id: ['ChatOllama'] } as Serialized, [], 'run-1');
      await handler.handleLLMEnd(llmResult, 'run-1');
      await handler.handleChainEnd();

      await handler.handleLLMStart({ id: ['ChatOllama'] } as Serialized, [], 'run-2');
      await handler.handleLLMEnd(llmResult, 'run-2');
      await handler.handleChainEnd();

      expect(calls).to.have.length(2);
      expect(calls[0].map((s) => s.spanId)).to.deep.equal(['run-1']);
      expect(calls[1].map((s) => s.spanId)).to.deep.equal(['run-2']);
    });

    it('uses runName for the span name when provided', async () => {
      const { store, calls } = fakeStore();
      const handler = new ObservabilityCallbackHandler('trace-1', store, 500);

      await handler.handleLLMStart(
        { id: ['ChatOllama'] } as Serialized,
        [],
        'run-1',
        undefined,
        undefined,
        undefined,
        undefined,
        'after-agent:classify',
      );
      await handler.handleLLMEnd(llmResult, 'run-1');
      await handler.handleChainEnd();

      expect(calls[0][0].name).to.equal('after-agent:classify');
    });

    it('falls back to the derived model name when runName is omitted', async () => {
      const { store, calls } = fakeStore();
      const handler = new ObservabilityCallbackHandler('trace-1', store, 500);

      await handler.handleLLMStart({ id: ['ChatOllama'] } as Serialized, [], 'run-1');
      await handler.handleLLMEnd(llmResult, 'run-1');
      await handler.handleChainEnd();

      expect(calls[0][0].name).to.equal('ChatOllama');
    });

    it('setNextSpanName() overrides the derived name AND a runName param (chains/retries never propagate runName to the inner LLM call)', async () => {
      const { store, calls } = fakeStore();
      const handler = new ObservabilityCallbackHandler('trace-1', store, 500);

      handler.setNextSpanName('after-agent:classify');
      // Simulates the real-world shape: runName param arrives as undefined
      // because it never made it down through withStructuredOutput/withRetry.
      await handler.handleLLMStart({ id: ['ChatOllama'] } as Serialized, [], 'run-1');
      await handler.handleLLMEnd(llmResult, 'run-1');
      await handler.handleChainEnd();

      expect(calls[0][0].name).to.equal('after-agent:classify');
    });

    it('setNextSpanName() applies to every retry attempt of the same step, not just the first', async () => {
      const { store, calls } = fakeStore();
      const handler = new ObservabilityCallbackHandler('trace-1', store, 500);

      handler.setNextSpanName('after-agent:extract');
      // .withRetry() re-invokes the chain (and fires handleLLMStart again)
      // on each attempt — all attempts are still the same logical step.
      await handler.handleLLMStart({ id: ['ChatOllama'] } as Serialized, [], 'attempt-1');
      await handler.handleLLMEnd(llmResult, 'attempt-1');
      await handler.handleLLMStart({ id: ['ChatOllama'] } as Serialized, [], 'attempt-2');
      await handler.handleLLMEnd(llmResult, 'attempt-2');
      await handler.handleChainEnd();

      expect(calls[0].map((s) => s.name)).to.deep.equal([
        'after-agent:extract',
        'after-agent:extract',
      ]);
    });

    it('a later setNextSpanName() call overrides an earlier one for the next step', async () => {
      const { store, calls } = fakeStore();
      const handler = new ObservabilityCallbackHandler('trace-1', store, 500);

      handler.setNextSpanName('after-agent:summarize');
      await handler.handleLLMStart({ id: ['ChatOllama'] } as Serialized, [], 'run-1');
      await handler.handleLLMEnd(llmResult, 'run-1');

      handler.setNextSpanName('after-agent:classify');
      await handler.handleLLMStart({ id: ['ChatOllama'] } as Serialized, [], 'run-2');
      await handler.handleLLMEnd(llmResult, 'run-2');
      await handler.handleChainEnd();

      expect(calls[0].map((s) => s.name)).to.deep.equal([
        'after-agent:summarize',
        'after-agent:classify',
      ]);
    });
  });
});
