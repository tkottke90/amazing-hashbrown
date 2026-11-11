import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { configManager } from '../../config/env.js';
import { bootThreadStore, getThreadStore } from '../../services/thread-store.js';
import { searchThreadsTool } from './search-threads.tool.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(threadId: string): any {
  return { configurable: { thread_id: threadId }, toolCallId: 'call-1' };
}

function seedMessages(threadId: string, count: number, startAt = 1): void {
  const store = getThreadStore();
  for (let i = startAt; i < startAt + count; i++) {
    store.insertMessage(threadId, {
      id: `${threadId}-m${i}`,
      kind: i % 2 === 0 ? 'assistant' : 'user',
      payload: { content: `message ${i} about widgets and gadgets` },
    });
  }
}

describe('agents/tools/search-threads', () => {
  let dir: string;

  // Keep embeddings disabled so rankMessages' fallback path (plain keyword
  // search) is deterministic and makes no network calls — the same
  // fallback the real tool relies on when no embedding provider is
  // reachable, just forced explicitly here instead of via a connection
  // failure.
  before(() => {
    configManager.set('embeddings', { enabled: false });
  });
  after(() => {
    configManager.set('embeddings', {});
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'search-threads-tool-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    bootThreadStore(db);
    const store = getThreadStore();
    store.upsertThreadOnFirstMessage('calling-thread', 'Caller', 'chat');
    store.upsertThreadOnFirstMessage('other-thread', 'Other', 'workspace-chat');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to search the calling thread itself', async () => {
    seedMessages('calling-thread', 3);
    const result = await searchThreadsTool.invoke(
      { threadId: 'calling-thread' },
      invokeConfig('calling-thread'),
    );
    expect(String(result)).to.include('your own current thread');
    expect(String(result)).to.include('search_conversation');
  });

  it('reports a nonexistent thread id plainly', async () => {
    const result = await searchThreadsTool.invoke(
      { threadId: 'no-such-thread' },
      invokeConfig('calling-thread'),
    );
    expect(String(result)).to.equal('No thread with id "no-such-thread" exists.');
  });

  it('returns the most recent messages as a tail when neither lookup nor a range is given', async () => {
    seedMessages('other-thread', 50);
    const result = await searchThreadsTool.invoke(
      { threadId: 'other-thread' },
      invokeConfig('calling-thread'),
    );
    const parsed = JSON.parse(String(result)) as Array<{ seq: number }>;
    expect(parsed.length).to.equal(40);
    expect(parsed[0]!.seq).to.equal(11); // the oldest of the newest 40 (seqs 11-50)
    expect(parsed[parsed.length - 1]!.seq).to.equal(50);
  });

  it('filters to a seq range when start/end are given', async () => {
    seedMessages('other-thread', 20);
    const result = await searchThreadsTool.invoke(
      { threadId: 'other-thread', start: 5, end: 8 },
      invokeConfig('calling-thread'),
    );
    const parsed = JSON.parse(String(result)) as Array<{ seq: number }>;
    expect(parsed.map((m) => m.seq)).to.deep.equal([5, 6, 7, 8]);
  });

  it('reports no messages in range rather than falling back to an unfiltered result', async () => {
    seedMessages('other-thread', 5);
    const result = await searchThreadsTool.invoke(
      { threadId: 'other-thread', start: 100, end: 200 },
      invokeConfig('calling-thread'),
    );
    expect(String(result)).to.equal('No messages found in thread "other-thread" in that seq range.');
  });

  it('ranks messages by a lookup query within the thread/range', async () => {
    const store = getThreadStore();
    store.insertMessage('other-thread', {
      id: 'other-thread-m1',
      kind: 'user',
      payload: { content: 'the deployment pipeline is broken' },
    });
    store.insertMessage('other-thread', {
      id: 'other-thread-m2',
      kind: 'assistant',
      payload: { content: 'completely unrelated small talk about the weather' },
    });

    const result = await searchThreadsTool.invoke(
      { threadId: 'other-thread', lookup: 'deployment pipeline' },
      invokeConfig('calling-thread'),
    );
    const parsed = JSON.parse(String(result)) as Array<{ seq: number; score: number }>;
    expect(parsed[0]!.seq).to.equal(1);
    expect(parsed[0]!.score).to.be.greaterThan(0);
  });
});
