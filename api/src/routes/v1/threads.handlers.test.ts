import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import Database from 'better-sqlite3';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { ThreadStore } from '../../services/thread-store.js';
import {
  listThreadsHandler,
  getThreadHandler,
  renameThreadHandler,
  deleteThreadHandler,
  forkThreadHandler,
} from './threads.handlers.js';

// A stub satisfying only the SqliteSaver methods threads.handlers.ts actually
// calls (deleteThread) — used for tests that never reach the fork path,
// where a real checkpointer isn't needed.
function stubCheckpointer() {
  const deletedThreadIds: string[] = [];
  return {
    deletedThreadIds,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deleteThread: async (threadId: string) => {
      deletedThreadIds.push(threadId);
    },
  };
}

function makeStore(): { store: ThreadStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'threads-handlers-test-'));
  const db = openDatabase(join(dir, 'test.db'));
  const store = new ThreadStore(db);
  return { store, dir };
}

describe('routes/v1/threads.handlers', () => {
  describe('listThreadsHandler', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => ({ store, dir } = makeStore()));
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('returns an empty array when there are no threads', () => {
      expect(listThreadsHandler(store)).to.deep.equal([]);
    });

    it('returns thread summaries once threads exist', () => {
      store.upsertThreadOnFirstMessage('t1', 'Hello');
      const list = listThreadsHandler(store);
      expect(list).to.have.lengthOf(1);
      expect(list[0]!.id).to.equal('t1');
    });
  });

  describe('getThreadHandler', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => ({ store, dir } = makeStore()));
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('returns 404 for an unknown thread', () => {
      const result = getThreadHandler(store, 'no-such-thread');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns the hydrated thread on success', () => {
      store.upsertThreadOnFirstMessage('t1', 'Hello');
      store.insertMessage('t1', { id: 'm1', kind: 'user', payload: { content: 'hi' } });

      const result = getThreadHandler(store, 't1');
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.title).to.equal('Hello');
        expect(result.data.messages).to.have.lengthOf(1);
      }
    });
  });

  describe('renameThreadHandler', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => ({ store, dir } = makeStore()));
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('returns 400 for an empty title', () => {
      store.upsertThreadOnFirstMessage('t1', 'Hello');
      const result = renameThreadHandler(store, 't1', '   ');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('returns 404 for an unknown thread', () => {
      const result = renameThreadHandler(store, 'no-such-thread', 'New title');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('renames on success', () => {
      const result = renameThreadHandler(store, 't1', '  New title  ');
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.title).to.equal('New title');
    });
  });

  describe('deleteThreadHandler', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => ({ store, dir } = makeStore()));
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    it('returns 404 for an unknown thread', async () => {
      const checkpointer = stubCheckpointer();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await deleteThreadHandler(store, checkpointer as any, 'no-such-thread');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
      expect(checkpointer.deletedThreadIds).to.deep.equal([]);
    });

    it('deletes the thread row and calls checkpointer.deleteThread', async () => {
      store.upsertThreadOnFirstMessage('t1', 'Hello');
      const checkpointer = stubCheckpointer();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await deleteThreadHandler(store, checkpointer as any, 't1');
      expect(result.ok).to.equal(true);
      expect(store.getThreadMeta('t1')).to.equal(null);
      expect(checkpointer.deletedThreadIds).to.deep.equal(['t1']);
    });
  });

  describe('forkThreadHandler', () => {
    let store: ThreadStore;
    let dir: string;
    let checkpointer: SqliteSaver;
    let checkpointDb: Database.Database;

    before(() => {
      ({ store, dir } = makeStore());
      checkpointDb = new Database(join(dir, 'checkpoints.db'));
      checkpointer = new SqliteSaver(checkpointDb);
    });
    after(() => {
      store.close();
      checkpointDb.close();
      rmSync(dir, { recursive: true });
    });

    it('returns 400 for a non-positive atSeq', async () => {
      const result = await forkThreadHandler(store, checkpointer, 't1', 0);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('returns 404 for an unknown source thread', async () => {
      const result = await forkThreadHandler(store, checkpointer, 'no-such-thread', 1);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 400 when atSeq does not resolve to a completed turn', async () => {
      store.upsertThreadOnFirstMessage('t1', 'Hello');
      store.insertMessage('t1', { id: 'u1', kind: 'user', payload: { content: 'hi' } }); // seq 1, no completed assistant turn yet

      const result = await forkThreadHandler(store, checkpointer, 't1', 1);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('forks successfully: copies messages, sets lineage, checkpoint chain resolves', async () => {
      const checkpoint = emptyCheckpoint();
      const config = { configurable: { thread_id: 't1', checkpoint_ns: '' } };
      await checkpointer.put(config, checkpoint, { source: 'loop', step: 0, parents: {} });

      store.insertMessage('t1', {
        id: 'a1',
        kind: 'assistant',
        status: 'done',
        checkpointId: checkpoint.id,
        payload: { content: 'hi there' },
      }); // seq 2

      const result = await forkThreadHandler(store, checkpointer, 't1', 2);
      expect(result.ok).to.equal(true);
      if (!result.ok) return;

      expect(result.data.forkedFromThreadId).to.equal('t1');
      expect(result.data.forkedFromSeq).to.equal(2);
      expect(result.data.title).to.equal('Hello (fork)');
      expect(result.data.messages.map((m) => m.id)).to.deep.equal(['u1', 'a1']);

      // The checkpoint itself was actually copied, not just the message rows.
      const forkedTuple = await checkpointer.getTuple({
        configurable: { thread_id: result.data.id },
      });
      expect(forkedTuple).to.not.equal(undefined);
      expect(forkedTuple!.checkpoint.id).to.equal(checkpoint.id);
    });
  });
});
