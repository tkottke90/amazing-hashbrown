import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { createWikiRegistry, type WikiRegistry } from '@tkottke90/llm-wiki';
import { bootObservability } from '../services/observability.js';
import { WorkspaceStore } from '../services/workspace-store.js';
import type { ObservabilityCallbackHandler } from './observability-handler.js';
import { logger } from '../config/logger.js';
import {
  extractLatestTurnText,
  drainPendingWikiUpdates,
  runAfterAgentPipeline,
  invokeStructured,
  getAfterAgentState,
} from './after-agent.js';

// Monkey-patches one logger method to record calls while forwarding to the real
// implementation — no mocking library needed (this repo uses mocha + chai only).
// Always call restore() in a finally block.
function captureLogCalls(method: 'warn' | 'info') {
  const spy = logger as unknown as Record<string, (msg: string, meta?: unknown) => void>;
  const original = spy[method].bind(logger);
  const calls: Array<{ message: string; meta: unknown }> = [];
  spy[method] = (message: string, meta?: unknown) => {
    calls.push({ message, meta });
    original(message, meta);
  };
  return {
    calls,
    restore: () => {
      spy[method] = original;
    },
  };
}

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

  describe('runAfterAgentPipeline() — write dispatch (createWikiPage/updateWikiPage)', () => {
    let dir: string;
    let registry: WikiRegistry;
    let store: WorkspaceStore;

    before(async () => {
      dir = mkdtempSync(join(tmpdir(), 'after-agent-write-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      bootObservability(db);
      store = new WorkspaceStore(db);
      registry = await createWikiRegistry({ wikiRoot: join(dir, 'wikiroot') });
      await registry.create({ id: 'user', domain: 'user', tags: [] });
    });

    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('creates a new page when ingestPrep finds no existing match', async () => {
      const threadId = `write-create-${crypto.randomUUID()}`;
      const { llm } = fakeStructuredLlm({
        'after-agent:summarize': { summary: 'User likes tea.' },
        'after-agent:classify': { shouldWrite: true, reason: 'new preference' },
        'after-agent:extract': {
          domainId: 'user',
          type: 'entity',
          title: 'Favorite Drink',
          tags: ['preferences'],
          body: 'The user prefers tea. See [[dns]] and [[proxy]].',
        },
      });

      await runAfterAgentPipeline({
        threadId,
        messages: [new HumanMessage('I prefer tea over coffee.')],
        llm,
        registry,
        store,
      });

      const state = getAfterAgentState(threadId);
      expect(state.status).to.equal('done');
      expect((state as { outcome: string }).outcome).to.equal('identified');

      const wiki = await registry.load('user');
      const page = await wiki.readPage('entities/favorite-drink.md');
      expect(page.content).to.contain('The user prefers tea.');
    });

    it('updates the existing page when ingestPrep finds a match, via the merge step', async () => {
      // Seed an existing page so the second run's ingestPrep matches it.
      const wiki = await registry.load('user');
      await wiki.commitPage({
        type: 'entity',
        title: 'Coffee Habit',
        tags: ['coffeehabit'],
        sources: [],
        body: 'The user drinks coffee every morning. See [[dns]] and [[proxy]].',
      });

      const threadId = `write-update-${crypto.randomUUID()}`;
      const { llm } = fakeStructuredLlm({
        'after-agent:summarize': { summary: 'User now drinks decaf.' },
        'after-agent:classify': { shouldWrite: true, reason: 'correction' },
        'after-agent:extract': {
          domainId: 'user',
          type: 'entity',
          title: 'Coffee Habit',
          tags: ['coffeehabit'],
          body: 'The user now drinks decaf coffee.',
        },
        'after-agent:merge-page': {
          body: 'The user drinks decaf coffee every morning. See [[dns]] and [[proxy]].',
        },
      });

      await runAfterAgentPipeline({
        threadId,
        messages: [new HumanMessage('Actually I switched to decaf coffee.')],
        llm,
        registry,
        store,
      });

      const updated = await wiki.readPage('entities/coffee-habit.md');
      expect(updated.content).to.contain('decaf');

      const state = getAfterAgentState(threadId);
      expect(state.status).to.equal('done');
      expect((state as { outcome: string }).outcome).to.equal('identified');
    });
  });

  describe('runAfterAgentPipeline() — post-write lint hook', () => {
    // Each test uses its own wiki domain so that wiki.lint() scanning the full
    // domain doesn't pick up pages left by other tests in this block.
    let dir: string;
    let testRegistry: WikiRegistry;
    let store: WorkspaceStore;

    before(async () => {
      dir = mkdtempSync(join(tmpdir(), 'after-agent-lint-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      bootObservability(db);
      store = new WorkspaceStore(db);
      testRegistry = await createWikiRegistry({ wikiRoot: join(dir, 'wikiroot') });
    });

    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('calls logger.warn when lint finds error-severity findings after a write', async () => {
      await testRegistry.create({ id: 'lint-errors', domain: 'lint', tags: [] });

      const threadId = `lint-errors-${crypto.randomUUID()}`;
      const { llm } = fakeStructuredLlm({
        'after-agent:summarize': { summary: 'Page with broken link.' },
        'after-agent:classify': { shouldWrite: true, reason: 'new info' },
        'after-agent:extract': {
          domainId: 'lint-errors',
          type: 'entity',
          title: 'Broken Page',
          tags: ['test'],
          body: 'This page references a missing page. See [[does-not-exist]].',
        },
      });

      const warnSpy = captureLogCalls('warn');
      try {
        await runAfterAgentPipeline({
          threadId,
          messages: [new HumanMessage('Write a page with a broken link.')],
          llm,
          registry: testRegistry,
          store,
        });
      } finally {
        warnSpy.restore();
      }

      const lintWarn = warnSpy.calls.find(
        (c) => c.message === 'after-agent: lint found errors after write',
      );
      expect(lintWarn, 'lint error warn should have fired').to.not.equal(undefined);
      const meta = lintWarn!.meta as Record<string, unknown>;
      expect(meta.wikiId).to.equal('lint-errors');
      expect(meta.threadId).to.equal(threadId);
      const errors = meta.errors as Array<{ check: string }>;
      expect(errors.some((e) => e.check === 'broken_links')).to.equal(true);

      // Write outcome is unaffected — lint runs after setAfterAgentDone.
      const state = getAfterAgentState(threadId);
      expect(state.status).to.equal('done');
      expect((state as { outcome: string }).outcome).to.equal('identified');
    });

    it('calls logger.info (not warn) when lint finds only non-error findings after a write', async () => {
      // A freshly-written page with a minimal body and a non-taxonomy tag naturally
      // triggers non-error lint checks (few-wikilinks, unknown-tag) without any
      // error-level findings. This covers the hook's info branch (checks.length > 0
      // but no errors) and verifies the hook never calls the error warn for these.
      await testRegistry.create({ id: 'lint-warn-only', domain: 'lint', tags: [] });

      const threadId = `lint-warn-only-${crypto.randomUUID()}`;
      const { llm } = fakeStructuredLlm({
        'after-agent:summarize': { summary: 'Brief note written.' },
        'after-agent:classify': { shouldWrite: true, reason: 'new info' },
        'after-agent:extract': {
          domainId: 'lint-warn-only',
          type: 'entity',
          title: 'Brief Note',
          tags: ['test'],
          body: 'A brief note with no outbound links.',
        },
      });

      const warnSpy = captureLogCalls('warn');
      const infoSpy = captureLogCalls('info');
      try {
        await runAfterAgentPipeline({
          threadId,
          messages: [new HumanMessage('Write a brief note.')],
          llm,
          registry: testRegistry,
          store,
        });
      } finally {
        warnSpy.restore();
        infoSpy.restore();
      }

      const lintErrorWarn = warnSpy.calls.find(
        (c) => c.message === 'after-agent: lint found errors after write',
      );
      const lintInfo = infoSpy.calls.find(
        (c) => c.message === 'after-agent: lint found non-error findings after write',
      );
      expect(
        lintErrorWarn,
        'no lint error warn should fire when there are no error-level findings',
      ).to.equal(undefined);
      expect(lintInfo, 'lint info should fire when there are non-error lint findings').to.not.equal(
        undefined,
      );
    });

    it('catches registry.lint() throws and logs a warn without flipping the write outcome', async () => {
      await testRegistry.create({ id: 'lint-throws', domain: 'lint', tags: [] });

      const threadId = `lint-throws-${crypto.randomUUID()}`;
      const { llm } = fakeStructuredLlm({
        'after-agent:summarize': { summary: 'Some fact.' },
        'after-agent:classify': { shouldWrite: true, reason: 'new info' },
        'after-agent:extract': {
          domainId: 'lint-throws',
          type: 'entity',
          title: 'Some Page',
          tags: ['test'],
          body: 'Some content.',
        },
      });

      // Temporarily make registry.lint() throw so the hook's inner try/catch fires.
      const originalLint = testRegistry.lint;
      (testRegistry as unknown as Record<string, unknown>).lint = async () => {
        throw new Error('simulated lint failure');
      };

      const warnSpy = captureLogCalls('warn');
      try {
        await runAfterAgentPipeline({
          threadId,
          messages: [new HumanMessage('Write something.')],
          llm,
          registry: testRegistry,
          store,
        });
      } finally {
        (testRegistry as unknown as Record<string, unknown>).lint = originalLint;
        warnSpy.restore();
      }

      const lintFailWarn = warnSpy.calls.find(
        (c) => c.message === 'after-agent: lint failed after write',
      );
      expect(lintFailWarn, 'lint-failed warn should have fired').to.not.equal(undefined);
      const meta = lintFailWarn!.meta as Record<string, unknown>;
      expect(meta.threadId).to.equal(threadId);

      // Write outcome is unaffected — the inner try/catch does not re-throw.
      const state = getAfterAgentState(threadId);
      expect(state.status).to.equal('done');
      expect((state as { outcome: string }).outcome).to.equal('identified');
    });
  });
});
