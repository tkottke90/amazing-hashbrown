import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { bootObservability } from '../services/observability.js';
import { evaluateLoopProgress } from './loop-reflection.js';

// Same fake as after-agent.test.ts's fakeStructuredLlm() — satisfies only
// the .withStructuredOutput().withRetry().invoke() chain invokeStructured()
// actually calls, and records every (runName, prompt) pair.
function fakeStructuredLlm(response: unknown) {
  const calls: { runName: string; prompt: string }[] = [];
  const llm = {
    withStructuredOutput() {
      return {
        withRetry() {
          return {
            async invoke(prompt: string, opts: { runName: string }) {
              calls.push({ runName: opts.runName, prompt });
              return response;
            },
          };
        },
      };
    },
  };
  return { llm: llm as unknown as BaseChatModel, calls };
}

describe('agents/loop-reflection', () => {
  describe('evaluateLoopProgress()', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-reflection-'));
    const db = openDatabase(join(dir, 'test.db'));

    before(() => {
      bootObservability(db);
    });

    after(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns the converging:true result and names the span loop-guard:reflect', async () => {
      const { llm, calls } = fakeStructuredLlm({
        converging: true,
        summary: 'narrowing down the cause',
        guidance: 'check the next file',
      });

      const result = await evaluateLoopProgress({
        toolCallPairs: [
          { toolName: 'shell_exec', args: { command: 'grep x' }, output: 'no matches' },
        ],
        reason: 'stagnation',
        threadId: 'thread-1',
        llm,
      });

      expect(result).to.deep.equal({
        converging: true,
        summary: 'narrowing down the cause',
        guidance: 'check the next file',
      });
      expect(calls).to.have.lengthOf(1);
      expect(calls[0].runName).to.equal('loop-guard:reflect');
      expect(calls[0].prompt).to.include('shell_exec');
    });

    it('returns the converging:false result as-is', async () => {
      const { llm } = fakeStructuredLlm({ converging: false, summary: 'not converging' });

      const result = await evaluateLoopProgress({
        toolCallPairs: [{ toolName: 'shell_exec', args: {}, output: 'no matches' }],
        reason: 'streak',
        threadId: 'thread-2',
        llm,
      });

      expect(result.converging).to.equal(false);
      expect(result.summary).to.equal('not converging');
    });

    it('fails safe toward converging:false when the reflection call itself throws', async () => {
      const throwingLlm = {
        withStructuredOutput() {
          return {
            withRetry() {
              return {
                async invoke() {
                  throw new Error('provider unreachable');
                },
              };
            },
          };
        },
      } as unknown as BaseChatModel;

      const result = await evaluateLoopProgress({
        toolCallPairs: [{ toolName: 'shell_exec', args: {}, output: 'no matches' }],
        reason: 'stagnation',
        threadId: 'thread-3',
        llm: throwingLlm,
      });

      expect(result.converging).to.equal(false);
      expect(result.summary).to.be.a('string');
      expect(result.summary.length).to.be.greaterThan(0);
    });
  });
});
