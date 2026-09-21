import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';
import { configManager } from '../config/env.js';
import { bootThreadStore, getThreadStore } from '../services/thread-store.js';
import {
  clearActiveSseWriter,
  getActiveSseWriter,
  getActiveTurnAbort,
} from './active-sse-writer.js';
import { ClassifiedTurnError } from './stream-handler.js';
import { recordAssistantStart } from './thread-message-writer.js';
import {
  streamWikiChatToSse,
  resumeWikiChatToSse,
  retryWikiChatToSse,
  type WikiChatStreamDeps,
} from './wiki-stream-handler.js';

// A minimal fake Express Response — these functions call res.write() only
// via the sink they build internally. Mirrors the identical helper in
// stream-handler.test.ts / workspace-chat-stream-handler.test.ts.
function fakeRes() {
  const chunks: string[] = [];
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res: { write: (chunk: string) => chunks.push(chunk) } as any,
    events: (): ChatSSEEvent[] =>
      chunks.map((c) => JSON.parse(c.replace(/^data: /, '').trim()) as ChatSSEEvent),
  };
}

// Regression coverage for issue #196: an interactive wiki-chat turn that's
// explicitly Stopped (via the new /stop route calling stopActiveTurn(),
// which aborts the controller registered here) must persist a 'cancelled'
// row and actually release the active-sse-writer mutex.
describe('agents/wiki-stream-handler — abort handling', () => {
  const TEST_PROVIDER = 'wiki-chat-abort-test-provider';
  let dir: string;
  let threadId: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type RawEvent = Record<string, any>;

  // Mirrors task-execution.test.ts's fakeAbortingAgent: looks up the REAL
  // controller streamWikiChatToSse/etc. already registered via
  // setActiveSseWriter(threadId, sink, controller), aborts it itself, then
  // throws — no ordering race with the code under test's own registration.
  function fakeAbortingAgent(tid: string, eventsBeforeAbort: RawEvent[] = []) {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      streamEvents: (): AsyncIterable<any> => {
        async function* gen() {
          for (const e of eventsBeforeAbort) yield e;
          const controller = getActiveTurnAbort(tid);
          if (!controller) throw new Error('test setup error: no controller registered');
          controller.abort();
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        return gen();
      },
      graph: {
        getState: async () => ({
          tasks: [],
          config: { configurable: { checkpoint_id: 'cp-test' } },
        }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  function fakeThrowingAgent(eventsBeforeThrow: RawEvent[] = []) {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      streamEvents: (): AsyncIterable<any> => {
        async function* gen() {
          for (const e of eventsBeforeThrow) yield e;
          throw new Error('simulated stream failure');
        }
        return gen();
      },
      graph: {
        getState: async () => ({
          tasks: [],
          config: { configurable: { checkpoint_id: 'cp-test' } },
        }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  function depsFor(agent: unknown): WikiChatStreamDeps {
    return {
      getWikiIngestionAgent: async () => ({ agent, systemPrompt: 'test system prompt' }) as never,
    };
  }

  async function expectClassifiedTurnError(promise: Promise<void>): Promise<ClassifiedTurnError> {
    try {
      await promise;
    } catch (err) {
      expect(err).to.be.instanceOf(ClassifiedTurnError);
      return err as ClassifiedTurnError;
    }
    throw new Error('expected the handler to throw');
  }

  before(() => {
    configManager.set('providers', [
      {
        name: TEST_PROVIDER,
        type: 'ollama',
        baseUrl: 'http://localhost:11434',
        defaultModel: 'test-model',
      },
    ]);
    configManager.set('defaultProvider', TEST_PROVIDER);
  });

  after(() => {
    configManager.set('providers', []);
    configManager.set('defaultProvider', '');
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wiki-stream-abort-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    bootThreadStore(db);
    threadId = randomUUID();
  });

  afterEach(() => {
    clearActiveSseWriter(threadId);
    rmSync(dir, { recursive: true, force: true });
  });

  it('streamWikiChatToSse persists a cancelled turn and releases the mutex when aborted mid-stream', async () => {
    const { res } = fakeRes();

    const err = await expectClassifiedTurnError(
      streamWikiChatToSse(
        res,
        threadId,
        'hello',
        Date.now(),
        undefined,
        undefined,
        depsFor(fakeAbortingAgent(threadId)),
      ),
    );
    expect(err.category).to.equal('cancelled');

    // The literal regression test for #196.
    expect(getActiveSseWriter(threadId)).to.equal(undefined);
    expect(getActiveTurnAbort(threadId)).to.equal(undefined);

    const persisted = getThreadStore()
      .getThreadMessages(threadId)
      .find((m) => m.kind === 'assistant' && m.status === 'error');
    expect(persisted, 'expected a persisted error-status assistant row').to.not.equal(undefined);
    expect((persisted!.payload as { errorCategory?: string }).errorCategory).to.equal('cancelled');
  });

  it('streamWikiChatToSse still fails normally (not cancelled) when the stream throws without being aborted', async () => {
    const { res } = fakeRes();

    const err = await expectClassifiedTurnError(
      streamWikiChatToSse(
        res,
        threadId,
        'hello',
        Date.now(),
        undefined,
        undefined,
        depsFor(fakeThrowingAgent()),
      ),
    );
    expect(err.category).to.not.equal('cancelled');
    expect(getActiveSseWriter(threadId)).to.equal(undefined);
  });

  it('resumeWikiChatToSse persists a cancelled turn and releases the mutex when aborted mid-stream', async () => {
    getThreadStore().upsertThreadOnFirstMessage(threadId, 'hello', 'wiki');
    recordAssistantStart(getThreadStore(), threadId, randomUUID(), new Date().toISOString());
    const { res } = fakeRes();

    const err = await expectClassifiedTurnError(
      resumeWikiChatToSse(
        res,
        threadId,
        'no-such-prompt',
        'yes',
        Date.now(),
        undefined,
        undefined,
        depsFor(fakeAbortingAgent(threadId)),
      ),
    );
    expect(err.category).to.equal('cancelled');
    expect(getActiveSseWriter(threadId)).to.equal(undefined);
  });

  it('retryWikiChatToSse persists a cancelled turn and releases the mutex when aborted mid-stream', async () => {
    getThreadStore().upsertThreadOnFirstMessage(threadId, 'hello', 'wiki');
    const failedId = randomUUID();
    recordAssistantStart(getThreadStore(), threadId, failedId, new Date().toISOString());
    getThreadStore().updateMessage(threadId, failedId, {
      status: 'error',
      payload: { content: '' },
    });
    const { res } = fakeRes();

    const err = await expectClassifiedTurnError(
      retryWikiChatToSse(
        res,
        threadId,
        Date.now(),
        undefined,
        undefined,
        depsFor(fakeAbortingAgent(threadId)),
      ),
    );
    expect(err.category).to.equal('cancelled');
    expect(getActiveSseWriter(threadId)).to.equal(undefined);
  });
});
