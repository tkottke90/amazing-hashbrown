import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { ObservabilityStore } from '@tkottke90/observability';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ThreadStore } from '../../services/thread-store.js';
import { bootObservability, getObservabilityStore } from '../../services/observability.js';
import { generateTitleHandler } from './threads.handlers.js';

// A fake model that always throws — the mocked "provider is unreachable"
// case, exactly the kind of external-boundary failure this repo's testing
// rule says must be simulated, never hit for real, in a developer test.
class ThrowingChatModel extends BaseChatModel {
  _llmType() {
    return 'throwing-fake';
  }
  async _generate(): Promise<never> {
    throw new Error('simulated provider failure');
  }
}

function makeStore(): { store: ThreadStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'generate-title-test-'));
  const db = openDatabase(join(dir, 'threads.db'));
  const store = new ThreadStore(db);
  return { store, dir };
}

describe('routes/v1/threads.handlers — generateTitleHandler', () => {
  let store: ThreadStore;
  let dir: string;
  let obsStore: ObservabilityStore;

  before(() => {
    ({ store, dir } = makeStore());
    const obsDb = openDatabase(join(dir, 'observability.db'));
    bootObservability(obsDb);
    obsStore = getObservabilityStore();
  });
  after(() => {
    store.close();
    rmSync(dir, { recursive: true });
  });

  it('returns 404 for an unknown thread', async () => {
    const model = new FakeListChatModel({ responses: ['Some Title'] });
    const result = await generateTitleHandler(store, model, 'no-such-thread', undefined, undefined);
    expect(result.ok).to.equal(false);
    if (!result.ok) expect(result.status).to.equal(404);
  });

  it('returns 400 for a thread with no user/assistant messages', async () => {
    store.upsertThreadOnFirstMessage('empty', 'Empty');
    // upsertThreadOnFirstMessage only creates the threads row — no messages yet.
    const model = new FakeListChatModel({ responses: ['Some Title'] });
    const result = await generateTitleHandler(store, model, 'empty', undefined, undefined);
    expect(result.ok).to.equal(false);
    if (!result.ok) expect(result.status).to.equal(400);
  });

  it('renames the thread with the model output, trimmed and unquoted, bumping updated_at', async () => {
    store.upsertThreadOnFirstMessage('t1', 'placeholder');
    store.insertMessage('t1', {
      id: 'u1',
      kind: 'user',
      payload: { content: 'How do I use Docker?' },
    });
    store.insertMessage('t1', {
      id: 'a1',
      kind: 'assistant',
      status: 'done',
      payload: { content: 'Docker lets you package apps into containers.' },
    });
    const beforeUpdatedAt = store.getThreadMeta('t1')!.updatedAt;

    const model = new FakeListChatModel({ responses: ['  "Docker Basics"  '] });
    const result = await generateTitleHandler(store, model, 't1', undefined, undefined);

    expect(result.ok).to.equal(true);
    if (result.ok) {
      expect(result.data.title).to.equal('Docker Basics');
      expect(result.data.updatedAt >= beforeUpdatedAt).to.equal(true);
    }
    expect(store.getThreadMeta('t1')!.title).to.equal('Docker Basics');
  });

  it('excludes tool_call/hitl_prompt/wiki_update rows from the transcript sent to the model', async () => {
    store.upsertThreadOnFirstMessage('t2', 'placeholder');
    store.insertMessage('t2', { id: 'u1', kind: 'user', payload: { content: 'Search for cats' } });
    store.insertMessage('t2', {
      id: 'tc1',
      kind: 'tool_call',
      status: 'done',
      payload: { toolCallId: 'tc1', toolName: 'search', inputs: {}, outputs: 'CAT SECRETS' },
    });
    store.insertMessage('t2', {
      id: 'a1',
      kind: 'assistant',
      status: 'done',
      payload: { content: 'Cats are great.' },
    });

    let capturedPrompt = '';
    class CapturingModel extends FakeListChatModel {
      override async invoke(input: unknown, options?: unknown) {
        capturedPrompt = String(input);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return super.invoke(input as any, options as any);
      }
    }
    const model = new CapturingModel({ responses: ['Cat Search'] });

    await generateTitleHandler(store, model, 't2', undefined, undefined);

    expect(capturedPrompt).to.include('Cats are great.');
    expect(capturedPrompt).to.include('Search for cats');
    expect(capturedPrompt).to.not.include('CAT SECRETS');
  });

  it('returns 500 and does not rename the thread when the model throws', async () => {
    store.upsertThreadOnFirstMessage('t3', 'Original Title');
    store.insertMessage('t3', { id: 'u1', kind: 'user', payload: { content: 'hello' } });

    const model = new ThrowingChatModel({});
    const result = await generateTitleHandler(store, model, 't3', undefined, undefined);

    expect(result.ok).to.equal(false);
    if (!result.ok) expect(result.status).to.equal(500);
    expect(store.getThreadMeta('t3')!.title).to.equal('Original Title');
  });

  it('saves an observability span even though a bare model.invoke() never fires handleChainEnd on its own', async () => {
    store.upsertThreadOnFirstMessage('t4', 'placeholder');
    store.insertMessage('t4', { id: 'u1', kind: 'user', payload: { content: 'hi' } });

    const before = obsStore.find({ threadId: 't4' }).length;
    const model = new FakeListChatModel({ responses: ['A Title'] });
    await generateTitleHandler(store, model, 't4', 'local', 'fake-model');

    const traces = obsStore.find({ threadId: 't4' });
    expect(traces.length).to.equal(before + 1);
    const full = obsStore.getTrace(traces[0]!.traceId);
    expect(full!.spans.length).to.be.greaterThan(0);
  });
});
