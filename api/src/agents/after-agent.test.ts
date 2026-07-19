import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { bootObservability } from '../services/observability.js';
import type { ObservabilityCallbackHandler } from './observability-handler.js';
import {
  extractLatestTurnText,
  drainPendingWikiUpdates,
  runAfterAgentPipeline,
  invokeStructured,
  getAfterAgentState,
} from './after-agent.js';

// A fake BaseChatModel satisfying only the .withStructuredOutput().withRetry().invoke()
// chain that after-agent.ts's invokeStructured() actually calls. Dispatches a canned
// response by `runName` and records every (runName, prompt) pair it was called with —
// used to inspect exactly what text was sent to the model, without a mocking library.
function fakeStructuredLlm(responses: Record<string, unknown>) {
  const calls: { runName: string; prompt: string }[] = [];
  const llm = {
    withStructuredOutput() {
      return {
        withRetry() {
          return {
            async invoke(prompt: string, opts: { runName: string }) {
              calls.push({ runName: opts.runName, prompt });
              const response = responses[opts.runName];
              if (response === undefined) {
                throw new Error(`fakeStructuredLlm: no response configured for "${opts.runName}"`);
              }
              return response;
            },
          };
        },
      };
    },
  };
  return { llm: llm as unknown as BaseChatModel, calls };
}

describe('agents/after-agent', () => {
  describe('extractLatestTurnText()', () => {
    it('returns an empty string when there are no human messages', () => {
      const messages = [new SystemMessage('you are a helpful assistant'), new AIMessage('hi')];
      expect(extractLatestTurnText(messages)).to.equal('');
    });

    it('returns an empty string for an empty message list', () => {
      expect(extractLatestTurnText([])).to.equal('');
    });

    it('includes the last human message and everything after it', () => {
      const messages = [
        new HumanMessage('what is rust'),
        new AIMessage('a systems programming language'),
        new HumanMessage('I work at Acme Corp as a backend engineer'),
        new AIMessage('got it, noted'),
      ];
      const result = extractLatestTurnText(messages);
      expect(result).to.include('I work at Acme Corp as a backend engineer');
      expect(result).to.include('got it, noted');
    });

    it('excludes messages from prior turns', () => {
      const messages = [
        new HumanMessage('what is rust'),
        new AIMessage('a systems programming language'),
        new HumanMessage('I work at Acme Corp'),
      ];
      const result = extractLatestTurnText(messages);
      expect(result).to.not.include('what is rust');
      expect(result).to.not.include('systems programming language');
      expect(result).to.include('I work at Acme Corp');
    });
  });

  describe('drainPendingWikiUpdates()', () => {
    it('returns an empty array for a thread with no pending events', () => {
      expect(drainPendingWikiUpdates('unknown-thread-id')).to.deep.equal([]);
    });

    it('returns an empty array on a second drain (no double-delivery)', () => {
      const threadId = 'drain-test-thread';
      expect(drainPendingWikiUpdates(threadId)).to.deep.equal([]);
      expect(drainPendingWikiUpdates(threadId)).to.deep.equal([]);
    });
  });

  describe('invokeStructured()', () => {
    it('calls handler.setNextSpanName(runName) before invoking the chain — RunnableConfig.runName does not reach the inner LLM call for .withStructuredOutput().withRetry() chains, confirmed empirically', async () => {
      const setNextSpanNameCalls: string[] = [];
      const fakeHandler = {
        setNextSpanName: (name: string) => setNextSpanNameCalls.push(name),
      } as unknown as ObservabilityCallbackHandler;

      const { llm } = fakeStructuredLlm({
        'after-agent:classify': { shouldWrite: true, reason: 'x' },
      });

      await invokeStructured(
        llm,
        z.object({ shouldWrite: z.boolean(), reason: z.string() }),
        'some prompt',
        fakeHandler,
        'after-agent:classify',
      );

      expect(setNextSpanNameCalls).to.deep.equal(['after-agent:classify']);
    });
  });

  describe('runAfterAgentPipeline() — classify sees the PRIOR summary, not the just-updated one', () => {
    let dir: string;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'after-agent-test-'));
      bootObservability(openDatabase(join(dir, 'test.db')));
    });

    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('does not fold the current turn into the summary classify is judged against', async () => {
      const threadId = `ordering-regression-${crypto.randomUUID()}`;

      // Turn 1 establishes a rolling summary.
      const { llm: llm1 } = fakeStructuredLlm({
        'after-agent:summarize': { summary: 'User is named Thomas.' },
        'after-agent:classify': { shouldWrite: false, reason: 'first turn, not asserted on' },
      });
      await runAfterAgentPipeline({
        threadId,
        messages: [new HumanMessage('My name is Thomas.')],
        llm: llm1,
      });

      // Turn 2 introduces a brand-new fact ("36 years old"). The bug: because
      // summarize() runs first and overwrites the thread's rolling summary
      // in place, a classify prompt built from the post-summarize state would
      // already contain "36 years old" — making the new fact look pre-existing.
      // shouldWrite: false keeps this test focused on the prompt text sent to
      // classify — the extract/wiki-write path is exercised elsewhere.
      const { llm: llm2, calls } = fakeStructuredLlm({
        'after-agent:summarize': { summary: 'User is named Thomas, 36 years old.' },
        'after-agent:classify': { shouldWrite: false, reason: 'novel fact, but untested here' },
      });
      await runAfterAgentPipeline({
        threadId,
        messages: [new HumanMessage('I am 36 years old.')],
        llm: llm2,
      });

      const classifyCall = calls.find((c) => c.runName === 'after-agent:classify');
      expect(classifyCall, 'classify should have been invoked').to.not.equal(undefined);
      // "36 years old" legitimately appears in the "Latest turn" section (it's
      // the text being classified) — the regression is specifically about the
      // "Rolling summary" section, which must reflect pre-turn state.
      expect(classifyCall!.prompt).to.include(
        'Rolling summary of the conversation so far:\nUser is named Thomas.\n',
      );
      expect(classifyCall!.prompt).to.not.include(
        'Rolling summary of the conversation so far:\nUser is named Thomas, 36 years old.',
      );
    });
  });

  describe('getAfterAgentState() / live status tracking', () => {
    let dir: string;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'after-agent-status-test-'));
      bootObservability(openDatabase(join(dir, 'test.db')));
    });

    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns idle for a thread that has never had AfterAgent activity', () => {
      expect(getAfterAgentState(`never-seen-${crypto.randomUUID()}`)).to.deep.equal({
        status: 'idle',
      });
    });

    it('ends at done/no-op after a classify:false run', async () => {
      const threadId = `status-no-op-${crypto.randomUUID()}`;
      const { llm } = fakeStructuredLlm({
        'after-agent:summarize': { summary: 'nothing notable yet' },
        'after-agent:classify': { shouldWrite: false, reason: 'small talk' },
      });

      await runAfterAgentPipeline({
        threadId,
        messages: [new HumanMessage('thanks!')],
        llm,
      });

      const state = getAfterAgentState(threadId);
      expect(state.status).to.equal('done');
      expect((state as { outcome: string }).outcome).to.equal('no-op');
    });

    it('ends at done/error when a pipeline step throws', async () => {
      const threadId = `status-error-${crypto.randomUUID()}`;
      // No responses configured at all — the very first invokeStructured()
      // call (summarize) throws, landing in runAfterAgentPipeline's catch.
      const { llm } = fakeStructuredLlm({});

      await runAfterAgentPipeline({
        threadId,
        messages: [new HumanMessage('this will blow up')],
        llm,
      });

      const state = getAfterAgentState(threadId);
      expect(state.status).to.equal('done');
      expect((state as { outcome: string }).outcome).to.equal('error');
    });

    it('leaves the status untouched when the pipeline is globally disabled or the turn text is empty', async () => {
      const threadId = `status-untouched-${crypto.randomUUID()}`;
      expect(getAfterAgentState(threadId)).to.deep.equal({ status: 'idle' });

      // requestAfterAgentEnabled: false short-circuits before startTrace()/the
      // 'running' write — status must stay exactly as it was (idle here).
      await runAfterAgentPipeline({
        threadId,
        messages: [new HumanMessage('hello')],
        requestAfterAgentEnabled: false,
      });

      expect(getAfterAgentState(threadId)).to.deep.equal({ status: 'idle' });
    });
  });
});
