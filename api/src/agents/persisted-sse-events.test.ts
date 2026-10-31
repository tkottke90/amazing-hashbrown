import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';
import { ThreadStore } from '../services/thread-store.js';
import { persistSseEvent, applyPersistedSseEvents } from './persisted-sse-events.js';

function makeStore(): { store: ThreadStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'persisted-sse-events-test-'));
  const db = openDatabase(join(dir, 'test.db'));
  const store = new ThreadStore(db);
  return { store, dir };
}

describe('agents/persisted-sse-events', () => {
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

  describe('persistSseEvent()', () => {
    it('persists a resource_created event and attaches seq', () => {
      const result = persistSseEvent(
        {
          type: 'resource_created',
          resourceType: 'workspace',
          name: 'My Workspace',
          location: '/tmp/projects/my-workspace',
          workspaceId: 'ws-1',
        },
        store,
        't1',
      );

      expect((result as unknown as { seq?: number }).seq).to.be.a('number');
      const persisted = store.getThreadMessages('t1').find((m) => m.kind === 'resource_card');
      expect(persisted, 'expected a persisted resource_card row').to.not.equal(undefined);
    });

    it('persists a wiki_updated event and attaches seq', () => {
      const result = persistSseEvent(
        {
          type: 'wiki_updated',
          pageTitle: 'Router',
          pageKind: 'created',
          wikiName: 'self',
          path: 'entities/router.md',
        },
        store,
        't1',
      );

      expect((result as unknown as { seq?: number }).seq).to.be.a('number');
      const persisted = store.getThreadMessages('t1').find((m) => m.kind === 'wiki_update');
      expect(persisted, 'expected a persisted wiki_update row').to.not.equal(undefined);
    });

    it('returns a Streamed-Only Event unchanged (no persister registered for it)', () => {
      const event: ChatSSEEvent = { type: 'wiki_domain_created', wikiId: 'homelab' };
      const result = persistSseEvent(event, store, 't1');

      expect(result).to.deep.equal(event);
    });

    it('returns an event that already carries seq unchanged, without inserting a second row', () => {
      const wikiUpdateRowCount = () =>
        store.getThreadMessages('t1').filter((m) => m.kind === 'wiki_update').length;
      const countBefore = wikiUpdateRowCount();

      const event: ChatSSEEvent = {
        type: 'wiki_updated',
        pageTitle: 'Already Persisted',
        pageKind: 'created',
        wikiName: 'self',
        path: 'entities/already-persisted.md',
        seq: 999,
      };
      const result = persistSseEvent(event, store, 't1');

      expect(result).to.deep.equal(event);
      expect(wikiUpdateRowCount()).to.equal(countBefore);
    });
  });

  describe('applyPersistedSseEvents()', () => {
    it('forwards the persisted event to the wrapped writer exactly once', () => {
      const received: ChatSSEEvent[] = [];
      const writer = applyPersistedSseEvents((event) => received.push(event), store, 't1');

      writer({
        type: 'wiki_updated',
        pageTitle: 'Switch',
        pageKind: 'created',
        wikiName: 'self',
        path: 'entities/switch.md',
      });

      expect(received).to.have.length(1);
      expect(received[0].type).to.equal('wiki_updated');
      expect((received[0] as unknown as { seq?: number }).seq).to.be.a('number');
    });

    it('forwards a Streamed-Only Event through unchanged', () => {
      const received: ChatSSEEvent[] = [];
      const writer = applyPersistedSseEvents((event) => received.push(event), store, 't1');

      writer({ type: 'wiki_domain_created', wikiId: 'homelab' });

      expect(received).to.deep.equal([{ type: 'wiki_domain_created', wikiId: 'homelab' }]);
    });
  });
});
