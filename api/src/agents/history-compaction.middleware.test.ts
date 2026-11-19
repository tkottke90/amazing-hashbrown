import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { configManager } from '../config/env.js';
import { bootObservability } from '../services/observability.js';
import {
  isHistoryCompacted,
  selectCompactionCandidates,
  summarizeToolMessage,
  createHistoryCompactionMiddleware,
} from './history-compaction.middleware.js';
import { getToolContent } from '../services/tool-content-store.js';
import { STUB_THRESHOLD_CHARS } from './tools/tool-stub.js';

async function callBeforeModel(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  middleware: any,
  state: { messages: BaseMessage[] },
): Promise<unknown> {
  return middleware.beforeModel(state, { context: {}, configurable: { thread_id: 'thread-test' } });
}

function bigContent(marker = ''): string {
  return `${marker}${'x'.repeat(STUB_THRESHOLD_CHARS + 1000)}`;
}

function smallContent(): string {
  return 'small result';
}

// Builds one tool-call round: an AIMessage requesting `toolName`, and its
// paired ToolMessage result — same shape summary-boundary.test.ts's
// makeOverflowingTurn() uses.
function makeRound(toolName: string, callId: string, resultContent: string): BaseMessage[] {
  return [
    new AIMessage({ content: '', tool_calls: [{ name: toolName, args: {}, id: callId }] }),
    new ToolMessage({ content: resultContent, tool_call_id: callId, name: toolName }),
  ];
}

describe('agents/history-compaction.middleware', () => {
  let dir: string;

  // summarizeToolMessage() always opens an observability trace
  // (startTurnObservability), same as every other model-call producer in
  // this codebase — getObservabilityStore() throws until bootObservability()
  // has run, same setup sub-agent-task-title.test.ts/after-agent.test.ts use.
  // A configured provider is also needed for the (few) tests that exercise
  // the real resolveSummarizerModel() rather than injecting a fake.
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'history-compaction-test-'));
    bootObservability(openDatabase(join(dir, 'observability.db')));
    configManager.set('providers', [
      {
        name: 'local',
        type: 'ollama',
        baseUrl: 'http://localhost:11434',
        defaultModel: 'test-model',
      },
    ]);
    configManager.set('defaultProvider', 'local');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
    configManager.set('providers', []);
    configManager.set('defaultProvider', '');
  });

  describe('isHistoryCompacted()', () => {
    it('recognizes a message tagged by summarizeToolMessage', async () => {
      const original = new ToolMessage({ content: bigContent(), tool_call_id: 'c1', name: 't' });
      const fakeLlm = {
        invoke: async () => ({ content: 'a summary' }),
      } as unknown as BaseChatModel;
      const replacement = await summarizeToolMessage(original, {
        threadId: 'thread-tag',
        llm: fakeLlm,
        resolvedProvider: 'ollama',
        resolvedModel: 'llama3.2',
        maxSourceChars: 16000,
      });
      expect(replacement).to.not.equal(null);
      expect(isHistoryCompacted(replacement!)).to.equal(true);
    });

    it('does not false-positive on an untagged message', () => {
      expect(
        isHistoryCompacted(new ToolMessage({ content: 'x', tool_call_id: 'c1', name: 't' })),
      ).to.equal(false);
    });

    it('does not false-positive on a message tagged with an unrelated hashbrown kind', () => {
      const msg = new AIMessage({
        content: 'x',
        additional_kwargs: { hashbrown: { kind: 'summary-boundary' } },
      });
      expect(isHistoryCompacted(msg)).to.equal(false);
    });
  });

  describe('selectCompactionCandidates()', () => {
    it('excludes the most recent tool-call round', () => {
      const messages = [new HumanMessage('go'), ...makeRound('big_tool', 'c1', bigContent())];
      expect(selectCompactionCandidates(messages)).to.deep.equal([]);
    });

    it('includes a big ToolMessage from an earlier round, excluding the latest round', () => {
      const round1 = makeRound('big_tool', 'c1', bigContent('ROUND1_'));
      const round2 = makeRound('big_tool', 'c2', bigContent('ROUND2_'));
      const messages = [new HumanMessage('go'), ...round1, ...round2];

      const candidates = selectCompactionCandidates(messages);
      expect(candidates).to.have.length(1);
      expect(candidates[0]!.tool_call_id).to.equal('c1');
    });

    it('excludes a ToolMessage under STUB_THRESHOLD_CHARS even in an earlier round', () => {
      const round1 = makeRound('small_tool', 'c1', smallContent());
      const round2 = makeRound('big_tool', 'c2', bigContent());
      const messages = [new HumanMessage('go'), ...round1, ...round2];

      expect(selectCompactionCandidates(messages)).to.deep.equal([]);
    });

    it('excludes a ToolMessage already tagged isHistoryCompacted', () => {
      const tagged = new ToolMessage({
        content: bigContent(),
        tool_call_id: 'c1',
        name: 'big_tool',
        additional_kwargs: { hashbrown: { kind: 'history-compaction', toolKey: 'kv_x' } },
      });
      const round1 = [
        new AIMessage({ content: '', tool_calls: [{ name: 'big_tool', args: {}, id: 'c1' }] }),
        tagged,
      ];
      const round2 = makeRound('big_tool', 'c2', bigContent());
      const messages = [new HumanMessage('go'), ...round1, ...round2];

      expect(selectCompactionCandidates(messages)).to.deep.equal([]);
    });

    it('isolates to the current turn — a big ToolMessage before the last HumanMessage is never a candidate', () => {
      const oldRound = makeRound('big_tool', 'c1', bigContent());
      const newRound = makeRound('big_tool', 'c2', bigContent());
      const messages = [
        new HumanMessage('first ask'),
        ...oldRound,
        new HumanMessage('second ask — this starts a new turn'),
        ...newRound,
      ];

      // c2 is the newest round, so it's protected too — nothing is eligible.
      expect(selectCompactionCandidates(messages)).to.deep.equal([]);
    });

    it('returns an empty array for messages with no ToolMessage at all', () => {
      expect(
        selectCompactionCandidates([new HumanMessage('hi'), new AIMessage('hello')]),
      ).to.deep.equal([]);
    });

    it('returns an empty array for an empty message list', () => {
      expect(selectCompactionCandidates([])).to.deep.equal([]);
    });
  });

  describe('summarizeToolMessage()', () => {
    it('replaces content with a summary, preserves tool_call_id/name/id, and offloads the original', async () => {
      const original = new ToolMessage({
        content: bigContent(),
        tool_call_id: 'call_abc',
        name: 'read_file',
        id: 'msg_123',
      });
      const fakeLlm = {
        invoke: async () => ({ content: 'the file contains a config value' }),
      } as unknown as BaseChatModel;

      const replacement = await summarizeToolMessage(original, {
        threadId: 'thread-summarize',
        llm: fakeLlm,
        resolvedProvider: 'ollama',
        resolvedModel: 'llama3.2',
        maxSourceChars: 16000,
      });

      expect(replacement).to.not.equal(null);
      expect(replacement!.tool_call_id).to.equal('call_abc');
      expect(replacement!.name).to.equal('read_file');
      expect(replacement!.id).to.equal('msg_123');
      expect(String(replacement!.content)).to.include('CONTENT OFFLOADED');
      expect(String(replacement!.content)).to.include('the file contains a config value');

      const keyMatch = String(replacement!.content).match(/^key:\s*(\S+)/m);
      expect(keyMatch, 'stub should advertise a toolKey').to.not.equal(null);
      expect(getToolContent('thread-summarize', keyMatch![1]!)).to.equal(original.content);
    });

    it('merges the compaction tag into additional_kwargs rather than overwriting it', async () => {
      const original = new ToolMessage({
        content: bigContent(),
        tool_call_id: 'c1',
        name: 't',
        additional_kwargs: { someOtherField: 'keep-me' },
      });
      const fakeLlm = { invoke: async () => ({ content: 'summary' }) } as unknown as BaseChatModel;

      const replacement = await summarizeToolMessage(original, {
        threadId: 'thread-merge',
        llm: fakeLlm,
        resolvedProvider: 'ollama',
        resolvedModel: 'llama3.2',
        maxSourceChars: 16000,
      });

      expect(replacement!.additional_kwargs['someOtherField']).to.equal('keep-me');
      expect(isHistoryCompacted(replacement!)).to.equal(true);
    });

    it('tail-caps the content sent to the summarizer at maxSourceChars', async () => {
      const content = `HEAD_MARKER${'x'.repeat(STUB_THRESHOLD_CHARS)}TAIL_MARKER`;
      const original = new ToolMessage({ content, tool_call_id: 'c1', name: 't' });
      let capturedPrompt = '';
      const fakeLlm = {
        invoke: async (prompt: string) => {
          capturedPrompt = prompt;
          return { content: 'summary' };
        },
      } as unknown as BaseChatModel;

      await summarizeToolMessage(original, {
        threadId: 'thread-cap',
        llm: fakeLlm,
        resolvedProvider: 'ollama',
        resolvedModel: 'llama3.2',
        maxSourceChars: 20,
      });

      expect(capturedPrompt).to.include('TAIL_MARKER');
      expect(capturedPrompt).to.not.include('HEAD_MARKER');
    });

    it('returns null without throwing when the model call fails', async () => {
      const original = new ToolMessage({ content: bigContent(), tool_call_id: 'c1', name: 't' });
      const fakeLlm = {
        invoke: async () => {
          throw new Error('provider unreachable');
        },
      } as unknown as BaseChatModel;

      const replacement = await summarizeToolMessage(original, {
        threadId: 'thread-fail',
        llm: fakeLlm,
        resolvedProvider: 'ollama',
        resolvedModel: 'llama3.2',
        maxSourceChars: 16000,
      });

      expect(replacement).to.equal(null);
    });

    it('returns null when the model responds with an empty/whitespace-only summary', async () => {
      const original = new ToolMessage({ content: bigContent(), tool_call_id: 'c1', name: 't' });
      const fakeLlm = { invoke: async () => ({ content: '   \n  ' }) } as unknown as BaseChatModel;

      const replacement = await summarizeToolMessage(original, {
        threadId: 'thread-empty',
        llm: fakeLlm,
        resolvedProvider: 'ollama',
        resolvedModel: 'llama3.2',
        maxSourceChars: 16000,
      });

      expect(replacement).to.equal(null);
    });
  });

  describe('createHistoryCompactionMiddleware() — beforeModel', () => {
    // Always provided, never actually called in these tests (the
    // summarizeToolMessage seam below replaces it before it would run) —
    // confirms the middleware never needs a real, configured provider.
    const neverResolve = () => {
      throw new Error('resolveSummarizerModel should not be called in this test');
    };

    function stateWithBigEarlierRound(): { messages: BaseMessage[] } {
      const round1 = makeRound('big_tool', 'c1', bigContent());
      const round2 = makeRound('big_tool', 'c2', bigContent());
      return { messages: [new HumanMessage('go'), ...round1, ...round2] };
    }

    it('no-ops when historyCompaction.enabled is false, even over threshold with eligible candidates', async () => {
      let called = false;
      const middleware = createHistoryCompactionMiddleware(
        { enabled: true, maxTokens: 100, safetyMarginPct: 0.85 },
        {
          enabled: false,
          thresholdPct: 0,
          summarizerProvider: undefined,
          summarizerModel: undefined,
          maxSourceChars: 16000,
        },
        {
          summarizeToolMessage: async () => {
            called = true;
            return null;
          },
          resolveSummarizerModel: neverResolve,
        },
      );

      const result = await callBeforeModel(middleware, stateWithBigEarlierRound());
      expect(result).to.equal(undefined);
      expect(called).to.equal(false);
    });

    it('no-ops when there is no thread_id, even over threshold with eligible candidates', async () => {
      let called = false;
      const middleware = createHistoryCompactionMiddleware(
        { enabled: true, maxTokens: 100, safetyMarginPct: 0.85 },
        {
          enabled: true,
          thresholdPct: 0,
          summarizerProvider: undefined,
          summarizerModel: undefined,
          maxSourceChars: 16000,
        },
        {
          summarizeToolMessage: async () => {
            called = true;
            return null;
          },
          resolveSummarizerModel: neverResolve,
        },
      );

      const result = await middleware.beforeModel(stateWithBigEarlierRound(), {
        context: {},
        configurable: {},
      });
      expect(result).to.equal(undefined);
      expect(called).to.equal(false);
    });

    it('no-ops when under thresholdPct * maxTokens', async () => {
      let called = false;
      const middleware = createHistoryCompactionMiddleware(
        { enabled: true, maxTokens: 10_000_000, safetyMarginPct: 0.85 },
        {
          enabled: true,
          thresholdPct: 0.6,
          summarizerProvider: undefined,
          summarizerModel: undefined,
          maxSourceChars: 16000,
        },
        {
          summarizeToolMessage: async () => {
            called = true;
            return null;
          },
          resolveSummarizerModel: neverResolve,
        },
      );

      const result = await callBeforeModel(middleware, stateWithBigEarlierRound());
      expect(result).to.equal(undefined);
      expect(called).to.equal(false);
    });

    it('no-ops when over threshold but zero candidates are eligible', async () => {
      const middleware = createHistoryCompactionMiddleware(
        { enabled: true, maxTokens: 10, safetyMarginPct: 0.85 },
        {
          enabled: true,
          thresholdPct: 0,
          summarizerProvider: undefined,
          summarizerModel: undefined,
          maxSourceChars: 16000,
        },
        { resolveSummarizerModel: neverResolve },
      );

      // Only a small tool result, nothing over STUB_THRESHOLD_CHARS.
      const state = { messages: [new HumanMessage('go'), ...makeRound('t', 'c1', smallContent())] };
      const result = await callBeforeModel(middleware, state);
      expect(result).to.equal(undefined);
    });

    it('replaces the eligible candidate and returns it in the result messages', async () => {
      const fakeLlm = {} as unknown as BaseChatModel;
      const resolveFake = () => ({
        llm: fakeLlm,
        resolvedProvider: 'ollama',
        resolvedModel: 'llama3.2',
      });
      const replacement = new ToolMessage({
        content: 'condensed',
        tool_call_id: 'c1',
        name: 'big_tool',
      });

      const middleware = createHistoryCompactionMiddleware(
        { enabled: true, maxTokens: 10, safetyMarginPct: 0.85 },
        {
          enabled: true,
          thresholdPct: 0,
          summarizerProvider: undefined,
          summarizerModel: undefined,
          maxSourceChars: 16000,
        },
        {
          summarizeToolMessage: async (candidate) =>
            candidate.tool_call_id === 'c1' ? replacement : null,
          resolveSummarizerModel: resolveFake,
        },
      );

      const result = (await callBeforeModel(middleware, stateWithBigEarlierRound())) as {
        messages: BaseMessage[];
      };

      expect(result).to.not.equal(undefined);
      const found = result.messages.find((m) => (m as ToolMessage).tool_call_id === 'c1');
      expect(found).to.equal(replacement);
      // The untouched (protected, most-recent-round) message is still the original.
      const untouched = result.messages.find((m) => (m as ToolMessage).tool_call_id === 'c2');
      expect(untouched).to.not.equal(replacement);
    });

    it('leaves a failed candidate unchanged and still replaces the others, without throwing', async () => {
      const fakeLlm = {} as unknown as BaseChatModel;
      const resolveFake = () => ({
        llm: fakeLlm,
        resolvedProvider: 'ollama',
        resolvedModel: 'llama3.2',
      });
      const replacement = new ToolMessage({
        content: 'condensed',
        tool_call_id: 'c1',
        name: 'big_tool',
      });

      const round1 = makeRound('big_tool', 'c1', bigContent('A_'));
      const round1b = makeRound('big_tool', 'c1b', bigContent('B_'));
      const round2 = makeRound('big_tool', 'c2', bigContent('C_'));
      const state = { messages: [new HumanMessage('go'), ...round1, ...round1b, ...round2] };

      const middleware = createHistoryCompactionMiddleware(
        { enabled: true, maxTokens: 10, safetyMarginPct: 0.85 },
        {
          enabled: true,
          thresholdPct: 0,
          summarizerProvider: undefined,
          summarizerModel: undefined,
          maxSourceChars: 16000,
        },
        {
          summarizeToolMessage: async (candidate) =>
            candidate.tool_call_id === 'c1' ? replacement : null,
          resolveSummarizerModel: resolveFake,
        },
      );

      const result = (await callBeforeModel(middleware, state)) as { messages: BaseMessage[] };
      expect(result).to.not.equal(undefined);
      const c1 = result.messages.find((m) => (m as ToolMessage).tool_call_id === 'c1');
      expect(c1).to.equal(replacement);
      const c1b = result.messages.find(
        (m) => (m as ToolMessage).tool_call_id === 'c1b',
      ) as ToolMessage;
      expect(c1b.content).to.equal(bigContent('B_'));
    });

    it('returns undefined (not an unchanged-messages object) when every candidate fails to summarize', async () => {
      const fakeLlm = {} as unknown as BaseChatModel;
      const resolveFake = () => ({
        llm: fakeLlm,
        resolvedProvider: 'ollama',
        resolvedModel: 'llama3.2',
      });

      const middleware = createHistoryCompactionMiddleware(
        { enabled: true, maxTokens: 10, safetyMarginPct: 0.85 },
        {
          enabled: true,
          thresholdPct: 0,
          summarizerProvider: undefined,
          summarizerModel: undefined,
          maxSourceChars: 16000,
        },
        { summarizeToolMessage: async () => null, resolveSummarizerModel: resolveFake },
      );

      const result = await callBeforeModel(middleware, stateWithBigEarlierRound());
      expect(result).to.equal(undefined);
    });

    it('with no config passed at all, falls back to the schema defaults (enabled, thresholdPct 0.6) and still attempts eligible candidates', async () => {
      let called = false;
      const fakeLlm = {} as unknown as BaseChatModel;
      const resolveFake = () => ({
        llm: fakeLlm,
        resolvedProvider: 'ollama',
        resolvedModel: 'llama3.2',
      });
      const middleware = createHistoryCompactionMiddleware(undefined, undefined, {
        summarizeToolMessage: async () => {
          called = true;
          return null;
        },
        resolveSummarizerModel: resolveFake,
      });

      // Default maxTokens is 32000, default thresholdPct 0.6 -> trigger point
      // is ~19200 estimated tokens (4 chars/token, tokens.ts). Needs a much
      // bigger earlier round than STUB_THRESHOLD_CHARS+1000 (~2750 tokens) to
      // actually cross that under the real defaults, unlike the other tests
      // above which use a tiny explicit maxTokens/thresholdPct to trigger
      // cheaply.
      const round1 = makeRound('big_tool', 'c1', 'y'.repeat(100_000));
      const round2 = makeRound('big_tool', 'c2', bigContent('ROUND2_'));
      const state = { messages: [new HumanMessage('go'), ...round1, ...round2] };

      await callBeforeModel(middleware, state);
      expect(called).to.equal(true);
    });
  });
});
