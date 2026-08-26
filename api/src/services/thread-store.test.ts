import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { ThreadStore } from './thread-store.js';

function makeStore(): { store: ThreadStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'thread-store-test-'));
  const db = openDatabase(join(dir, 'test.db'));
  const store = new ThreadStore(db);
  return { store, dir };
}

describe('services/thread-store', () => {
  describe('upsertThreadOnFirstMessage / touchThread', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => ({ store, dir } = makeStore()));
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('creates a thread row on first call', () => {
      store.upsertThreadOnFirstMessage('t1', 'Hello there');
      const meta = store.getThreadMeta('t1');
      expect(meta).to.not.equal(null);
      expect(meta!.title).to.equal('Hello there');
      expect(meta!.forkedFromThreadId).to.equal(null);
    });

    it('is a no-op on a second call for the same id', () => {
      store.upsertThreadOnFirstMessage('t1', 'A different title');
      const meta = store.getThreadMeta('t1');
      expect(meta!.title).to.equal('Hello there');
    });

    it('touchThread bumps updated_at', async () => {
      const before = store.getThreadMeta('t1')!.updatedAt;
      await new Promise((r) => setTimeout(r, 5));
      store.touchThread('t1');
      const after = store.getThreadMeta('t1')!.updatedAt;
      expect(after >= before).to.equal(true);
    });
  });

  describe('listThreads', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => ({ store, dir } = makeStore()));
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('orders by updated_at desc', async () => {
      store.upsertThreadOnFirstMessage('older', 'Older');
      await new Promise((r) => setTimeout(r, 5));
      store.upsertThreadOnFirstMessage('newer', 'Newer');

      const list = store.listThreads();
      expect(list.map((t) => t.id)).to.deep.equal(['newer', 'older']);
    });
  });

  describe('renameThread', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => ({ store, dir } = makeStore()));
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('renames an existing thread and bumps updated_at', () => {
      store.upsertThreadOnFirstMessage('t1', 'Original');
      const result = store.renameThread('t1', 'Renamed');
      expect(result).to.not.equal(null);
      expect(result!.title).to.equal('Renamed');
    });

    it('returns null for an unknown thread', () => {
      expect(store.renameThread('no-such-thread', 'X')).to.equal(null);
    });
  });

  describe('deleteThread', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => ({ store, dir } = makeStore()));
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('deletes the thread and its messages, returns true', () => {
      store.upsertThreadOnFirstMessage('t1', 'Hello');
      store.insertMessage('t1', { id: 'm1', kind: 'user', payload: { content: 'hi' } });

      expect(store.deleteThread('t1')).to.equal(true);
      expect(store.getThreadMeta('t1')).to.equal(null);
      expect(store.getThreadMessages('t1')).to.deep.equal([]);
    });

    it('returns false for an unknown thread', () => {
      expect(store.deleteThread('no-such-thread')).to.equal(false);
    });
  });

  describe('insertMessage / updateMessage / nextSeq sequencing', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => ({ store, dir } = makeStore()));
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('assigns sequential seq values starting at 1', () => {
      store.upsertThreadOnFirstMessage('t1', 'Hello');
      const m1 = store.insertMessage('t1', { id: 'm1', kind: 'user', payload: { content: 'a' } });
      const m2 = store.insertMessage('t1', {
        id: 'm2',
        kind: 'assistant',
        status: 'streaming',
        payload: { content: '' },
      });
      expect(m1.seq).to.equal(1);
      expect(m2.seq).to.equal(2);
    });

    it('seq sequencing is independent per thread', () => {
      store.upsertThreadOnFirstMessage('t2', 'Other');
      const m = store.insertMessage('t2', {
        id: 'm1',
        kind: 'user',
        payload: { content: 'b' },
      });
      expect(m.seq).to.equal(1);
    });

    it('updateMessage patches status and payload in place', () => {
      store.updateMessage('t1', 'm2', { status: 'done', payload: { content: 'final' } });
      const messages = store.getThreadMessages('t1');
      const m2 = messages.find((m) => m.id === 'm2')!;
      expect(m2.status).to.equal('done');
      expect(m2.payload).to.deep.equal({ content: 'final' });
    });

    it('updateMessage is a no-op for an unknown row', () => {
      expect(() => store.updateMessage('t1', 'no-such-id', { status: 'done' })).to.not.throw();
    });
  });

  describe('getMessage', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => ({ store, dir } = makeStore()));
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('returns a single message by id', () => {
      store.upsertThreadOnFirstMessage('t1', 'Hello');
      store.insertMessage('t1', { id: 'm1', kind: 'user', payload: { content: 'hi' } });

      const msg = store.getMessage('t1', 'm1');
      expect(msg).to.not.equal(null);
      expect(msg!.payload).to.deep.equal({ content: 'hi' });
    });

    it('returns null for an unknown id', () => {
      expect(store.getMessage('t1', 'no-such-id')).to.equal(null);
    });
  });

  describe('resolveRetryTarget', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => ({ store, dir } = makeStore()));
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('returns null for an empty thread', () => {
      store.upsertThreadOnFirstMessage('empty', 'Empty');
      expect(store.resolveRetryTarget('empty')).to.equal(null);
    });

    it('returns null when the last message is a successful assistant turn', () => {
      store.upsertThreadOnFirstMessage('t1', 'Hello');
      store.insertMessage('t1', { id: 'a1', kind: 'assistant', status: 'done', payload: {} });
      expect(store.resolveRetryTarget('t1')).to.equal(null);
    });

    it('returns the id when the last message is a failed assistant turn', () => {
      store.upsertThreadOnFirstMessage('t2', 'Hello');
      store.insertMessage('t2', { id: 'a1', kind: 'assistant', status: 'error', payload: {} });
      expect(store.resolveRetryTarget('t2')).to.equal('a1');
    });

    it('returns null once the failed turn is no longer the tail (e.g. after a retry landed)', () => {
      store.upsertThreadOnFirstMessage('t3', 'Hello');
      store.insertMessage('t3', { id: 'a1', kind: 'assistant', status: 'error', payload: {} });
      store.insertMessage('t3', {
        id: 'a2',
        kind: 'assistant',
        status: 'done',
        retryOf: 'a1',
        payload: {},
      });
      expect(store.resolveRetryTarget('t3')).to.equal(null);
    });
  });

  describe('interruptPendingToolCalls', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => ({ store, dir } = makeStore()));
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('sweeps pending tool_call rows to interrupted, leaves done rows alone', () => {
      store.upsertThreadOnFirstMessage('t1', 'Hello');
      store.insertMessage('t1', {
        id: 'tc-pending',
        kind: 'tool_call',
        status: 'pending',
        payload: {},
      });
      store.insertMessage('t1', { id: 'tc-done', kind: 'tool_call', status: 'done', payload: {} });

      store.interruptPendingToolCalls('t1');

      const messages = store.getThreadMessages('t1');
      expect(messages.find((m) => m.id === 'tc-pending')!.status).to.equal('interrupted');
      expect(messages.find((m) => m.id === 'tc-done')!.status).to.equal('done');
    });
  });

  describe('getThreadMessages — showErrorMessages visibility filter', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => {
      ({ store, dir } = makeStore());
      store.upsertThreadOnFirstMessage('t1', 'Hello');
      // A resolved failure: error(A) -> retried by done(B, retryOf=A)
      store.insertMessage('t1', { id: 'a', kind: 'assistant', status: 'error', payload: {} });
      store.insertMessage('t1', {
        id: 'b',
        kind: 'assistant',
        status: 'done',
        retryOf: 'a',
        payload: {},
      });
    });
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('hides a superseded error row by default', () => {
      const messages = store.getThreadMessages('t1');
      expect(messages.map((m) => m.id)).to.deep.equal(['b']);
    });

    it('shows the superseded error row when showErrors is true', () => {
      const messages = store.getThreadMessages('t1', { showErrors: true });
      expect(messages.map((m) => m.id)).to.deep.equal(['a', 'b']);
    });

    it('never hides an unresolved error row at the tail, even with showErrors false', () => {
      store.insertMessage('t1', { id: 'c', kind: 'assistant', status: 'error', payload: {} });
      const messages = store.getThreadMessages('t1');
      expect(messages.map((m) => m.id)).to.deep.equal(['b', 'c']);
    });
  });

  describe('getThread', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => ({ store, dir } = makeStore()));
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('returns null for an unknown thread', () => {
      expect(store.getThread('no-such-thread')).to.equal(null);
    });

    it('returns thread metadata plus its messages', () => {
      store.upsertThreadOnFirstMessage('t1', 'Hello');
      store.insertMessage('t1', { id: 'm1', kind: 'user', payload: { content: 'hi' } });

      const detail = store.getThread('t1');
      expect(detail).to.not.equal(null);
      expect(detail!.title).to.equal('Hello');
      expect(detail!.messages).to.have.lengthOf(1);
      expect(detail!.messages[0]!.id).to.equal('m1');
    });
  });

  describe('fork support: resolveForkCheckpointId / copyMessagesToNewThread', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => {
      ({ store, dir } = makeStore());
      store.upsertThreadOnFirstMessage('src', 'Source thread');
      store.insertMessage('src', { id: 'u1', kind: 'user', payload: { content: 'q1' } }); // seq 1
      store.insertMessage('src', {
        id: 'a1',
        kind: 'assistant',
        status: 'done',
        checkpointId: 'cp-1',
        payload: { content: 'r1' },
      }); // seq 2
      store.insertMessage('src', { id: 'u2', kind: 'user', payload: { content: 'q2' } }); // seq 3
      store.insertMessage('src', {
        id: 'a2',
        kind: 'assistant',
        status: 'streaming',
        payload: { content: '' },
      }); // seq 4, not done yet
    });
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('resolves the nearest completed-turn checkpoint at or before atSeq', () => {
      expect(store.resolveForkCheckpointId('src', 2)).to.equal('cp-1');
      expect(store.resolveForkCheckpointId('src', 3)).to.equal('cp-1');
    });

    it('returns null when no completed turn exists at or before atSeq', () => {
      expect(store.resolveForkCheckpointId('src', 1)).to.equal(null);
    });

    it('does not resolve to a still-streaming assistant row', () => {
      // seq 4 is 'streaming', not 'done' — must still resolve to the last done turn (seq 2)
      expect(store.resolveForkCheckpointId('src', 4)).to.equal('cp-1');
    });

    it('copies messages up to atSeq into a new thread, preserving ids', () => {
      store.createForkedThread('fork-1', 'Source thread (fork)', 'src', 2);
      store.copyMessagesToNewThread('src', 'fork-1', 2);

      const forked = store.getThread('fork-1');
      expect(forked!.forkedFromThreadId).to.equal('src');
      expect(forked!.forkedFromSeq).to.equal(2);
      expect(forked!.messages.map((m) => m.id)).to.deep.equal(['u1', 'a1']);
      expect(forked!.messages.map((m) => m.seq)).to.deep.equal([1, 2]);
    });
  });

  describe('getThreadMessages afterMessageId cursor', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => ({ store, dir } = makeStore()));
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('returns only messages after the cursor id', () => {
      store.upsertThreadOnFirstMessage('cursor-t1', 'Cursor thread');
      store.insertMessage('cursor-t1', { id: 'c-u1', kind: 'user', payload: { content: 'one' } });
      store.insertMessage('cursor-t1', {
        id: 'c-a1',
        kind: 'assistant',
        status: 'done',
        payload: { content: 'one reply' },
      });
      store.insertMessage('cursor-t1', {
        id: 'c-summary',
        kind: 'summary',
        payload: { content: 'summary of the above' },
      });
      store.insertMessage('cursor-t1', { id: 'c-u2', kind: 'user', payload: { content: 'two' } });
      store.insertMessage('cursor-t1', {
        id: 'c-a2',
        kind: 'assistant',
        status: 'done',
        payload: { content: 'two reply' },
      });

      const all = store.getThreadMessages('cursor-t1');
      expect(all.map((m) => m.id)).to.deep.equal(['c-u1', 'c-a1', 'c-summary', 'c-u2', 'c-a2']);

      const sinceSummary = store.getThreadMessages('cursor-t1', { afterMessageId: 'c-summary' });
      expect(sinceSummary.map((m) => m.id)).to.deep.equal(['c-u2', 'c-a2']);
    });

    it('is a no-op when afterMessageId does not match any row', () => {
      const all = store.getThreadMessages('cursor-t1');
      const result = store.getThreadMessages('cursor-t1', { afterMessageId: 'no-such-id' });
      expect(result.map((m) => m.id)).to.deep.equal(all.map((m) => m.id));
    });
  });

  describe('migration versioning', () => {
    it('records version 4 in schema_migrations', () => {
      const dir = mkdtempSync(join(tmpdir(), 'thread-store-migration-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      const store = new ThreadStore(db);

      const versions = (
        db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>
      ).map((r) => r.version);
      expect(versions).to.include(4);

      store.close();
      rmSync(dir, { recursive: true });
    });
  });
});
