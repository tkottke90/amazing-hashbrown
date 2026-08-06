import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { ThreadStore } from '../services/thread-store.js';
import {
  recordUserMessage,
  recordAssistantStart,
  finalizeAssistant,
  failAssistant,
  recordRetryAttempt,
  recordToolCallStart,
  finalizeToolCall,
  recordHitlPrompt,
  resolveHitlPrompt,
  recordWikiUpdate,
} from './thread-message-writer.js';

function makeStore(): { store: ThreadStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'thread-message-writer-test-'));
  const db = openDatabase(join(dir, 'test.db'));
  const store = new ThreadStore(db);
  return { store, dir };
}

describe('agents/thread-message-writer', () => {
  describe('recordUserMessage', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => {
      ({ store, dir } = makeStore());
      store.upsertThreadOnFirstMessage('t1', 'Hello');
    });
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('inserts a user row with content and sentAt, no status, returns the assigned seq', () => {
      const seq = recordUserMessage(store, 't1', 'u1', 'hi there', '2026-07-18T00:00:00.000Z');
      const msg = store.getMessage('t1', 'u1')!;
      expect(msg.kind).to.equal('user');
      expect(msg.status).to.equal(null);
      expect(msg.payload).to.deep.equal({
        content: 'hi there',
        sentAt: '2026-07-18T00:00:00.000Z',
      });
      expect(seq).to.equal(msg.seq);
    });

    it('never throws, even against a thread that does not exist (FK violation swallowed), returns null', () => {
      let seq: number | null = -1;
      expect(() => {
        seq = recordUserMessage(store, 'no-such-thread', 'u2', 'hi', '2026-07-18T00:00:00.000Z');
      }).to.not.throw();
      expect(seq).to.equal(null);
      expect(store.getMessage('no-such-thread', 'u2')).to.equal(null);
    });
  });

  describe('assistant lifecycle: start -> finalize / fail', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => {
      ({ store, dir } = makeStore());
      store.upsertThreadOnFirstMessage('t1', 'Hello');
    });
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('recordAssistantStart inserts status: streaming with empty content', () => {
      recordAssistantStart(store, 't1', 'a1', '2026-07-18T00:00:00.000Z');
      const msg = store.getMessage('t1', 'a1')!;
      expect(msg.status).to.equal('streaming');
      expect(msg.payload).to.deep.equal({ content: '', sentAt: '2026-07-18T00:00:00.000Z' });
    });

    it('finalizeAssistant updates to done, stamps checkpointId, includes thoughtContent when present', () => {
      finalizeAssistant(
        store,
        't1',
        'a1',
        'final answer',
        'my reasoning',
        '2026-07-18T00:00:00.000Z',
        'cp-1',
      );
      const msg = store.getMessage('t1', 'a1')!;
      expect(msg.status).to.equal('done');
      expect(msg.checkpointId).to.equal('cp-1');
      expect(msg.payload).to.deep.equal({
        content: 'final answer',
        thoughtContent: 'my reasoning',
        sentAt: '2026-07-18T00:00:00.000Z',
      });
    });

    it('finalizeAssistant omits thoughtContent when empty', () => {
      recordAssistantStart(store, 't1', 'a2', '2026-07-18T00:00:00.000Z');
      finalizeAssistant(
        store,
        't1',
        'a2',
        'no thinking here',
        '',
        '2026-07-18T00:00:00.000Z',
        null,
      );
      const msg = store.getMessage('t1', 'a2')!;
      expect(msg.payload).to.deep.equal({
        content: 'no thinking here',
        sentAt: '2026-07-18T00:00:00.000Z',
      });
      expect(msg.checkpointId).to.equal(null);
    });

    it('failAssistant marks status: error and sweeps pending tool_call rows to interrupted', () => {
      recordAssistantStart(store, 't1', 'a3', '2026-07-18T00:00:00.000Z');
      recordToolCallStart(store, 't1', 'tc1', 'search', { q: 'x' });

      failAssistant(store, 't1', 'a3', 'partial...', '2026-07-18T00:00:00.000Z');

      expect(store.getMessage('t1', 'a3')!.status).to.equal('error');
      expect(store.getMessage('t1', 'tc1')!.status).to.equal('interrupted');
    });
  });

  describe('recordRetryAttempt', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => {
      ({ store, dir } = makeStore());
      store.upsertThreadOnFirstMessage('t1', 'Hello');
      recordAssistantStart(store, 't1', 'a1', '2026-07-18T00:00:00.000Z');
      failAssistant(store, 't1', 'a1', '', '2026-07-18T00:00:00.000Z');
    });
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('inserts a new streaming row linked via retryOf, does not touch the original', () => {
      recordRetryAttempt(store, 't1', 'a2', 'a1', '2026-07-18T00:01:00.000Z');

      const retry = store.getMessage('t1', 'a2')!;
      expect(retry.status).to.equal('streaming');
      expect(retry.retryOf).to.equal('a1');

      const original = store.getMessage('t1', 'a1')!;
      expect(original.status).to.equal('error');
      expect(original.retryOf).to.equal(null);
    });
  });

  describe('tool_call lifecycle', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => {
      ({ store, dir } = makeStore());
      store.upsertThreadOnFirstMessage('t1', 'Hello');
    });
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('recordToolCallStart inserts pending, finalizeToolCall replaces with outputs and done', () => {
      recordToolCallStart(store, 't1', 'tc1', 'add_numbers', { a: 2, b: 3 });
      expect(store.getMessage('t1', 'tc1')!.status).to.equal('pending');

      finalizeToolCall(store, 't1', 'tc1', 'add_numbers', { a: 2, b: 3 }, '5');
      const msg = store.getMessage('t1', 'tc1')!;
      expect(msg.status).to.equal('done');
      expect(msg.payload).to.deep.equal({
        toolCallId: 'tc1',
        toolName: 'add_numbers',
        inputs: { a: 2, b: 3 },
        outputs: '5',
      });
    });
  });

  describe('hitl_prompt lifecycle', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => {
      ({ store, dir } = makeStore());
      store.upsertThreadOnFirstMessage('t1', 'Hello');
    });
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('recordHitlPrompt inserts pending with the prompt fields', () => {
      recordHitlPrompt(store, 't1', 'p1', {
        question: 'Proceed?',
        promptKind: 'yes_no',
        approveLabel: 'Yes',
        rejectLabel: 'No',
      });
      const msg = store.getMessage('t1', 'p1')!;
      expect(msg.status).to.equal('pending');
      expect(msg.payload).to.deep.equal({
        promptId: 'p1',
        question: 'Proceed?',
        promptKind: 'yes_no',
        approveLabel: 'Yes',
        rejectLabel: 'No',
      });
    });

    it('recordHitlPrompt stores command and reason for shell_approval', () => {
      recordHitlPrompt(store, 't1', 'p2', {
        question: 'Allow command: `ls -la`\n\nReason: list files',
        promptKind: 'shell_approval',
        command: 'ls -la',
        reason: 'list files',
      });
      const msg = store.getMessage('t1', 'p2')!;
      expect(msg.status).to.equal('pending');
      const payload = msg.payload as Record<string, unknown>;
      expect(payload.command).to.equal('ls -la');
      expect(payload.reason).to.equal('list files');
    });

    it('resolveHitlPrompt preserves the original fields and adds the answer', () => {
      resolveHitlPrompt(store, 't1', 'p1', 'yes');
      const msg = store.getMessage('t1', 'p1')!;
      expect(msg.status).to.equal('answered');
      expect(msg.payload).to.deep.equal({
        promptId: 'p1',
        question: 'Proceed?',
        promptKind: 'yes_no',
        approveLabel: 'Yes',
        rejectLabel: 'No',
        answer: 'yes',
      });
    });

    it('resolveHitlPrompt is a no-op (does not throw) for an unknown promptId', () => {
      expect(() => resolveHitlPrompt(store, 't1', 'no-such-prompt', 'yes')).to.not.throw();
    });
  });

  describe('hitl_prompt strict write behaviour', () => {
    it('recordHitlPrompt throws when the DB write fails', () => {
      const { store: s, dir: d } = makeStore();
      s.upsertThreadOnFirstMessage('t1', 'Hello');
      s.close();
      expect(() =>
        recordHitlPrompt(s, 't1', 'px', { question: 'Q?', promptKind: 'yes_no' }),
      ).to.throw();
      rmSync(d, { recursive: true });
    });

    it('resolveHitlPrompt throws when the DB update fails', () => {
      const { store: s, dir: d } = makeStore();
      s.upsertThreadOnFirstMessage('t1', 'Hello');
      recordHitlPrompt(s, 't1', 'py', { question: 'Q?', promptKind: 'yes_no' });
      s.close();
      expect(() => resolveHitlPrompt(s, 't1', 'py', 'yes')).to.throw();
      rmSync(d, { recursive: true });
    });
  });

  describe('recordWikiUpdate', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => {
      ({ store, dir } = makeStore());
      store.upsertThreadOnFirstMessage('t1', 'Hello');
    });
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('inserts a complete-as-emitted wiki_update row', () => {
      recordWikiUpdate(store, 't1', 'w1', 'Entity: Foo', 'entity', 'user');
      const msg = store.getMessage('t1', 'w1')!;
      expect(msg.kind).to.equal('wiki_update');
      expect(msg.status).to.equal(null);
      expect(msg.payload).to.deep.equal({
        pageTitle: 'Entity: Foo',
        pageKind: 'entity',
        wikiName: 'user',
      });
    });
  });
});
