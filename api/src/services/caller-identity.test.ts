import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { ThreadStore, type ThreadType } from './thread-store.js';
import { formatCallerLabel, resolveCallerIdentity } from './caller-identity.js';

function makeStore(): { store: ThreadStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'caller-identity-test-'));
  const db = openDatabase(join(dir, 'test.db'));
  const store = new ThreadStore(db);
  return { store, dir };
}

describe('services/caller-identity', () => {
  describe('formatCallerLabel', () => {
    it('prefixes the kind label onto the given name', () => {
      expect(formatCallerLabel('chat', 'Release notes draft')).to.equal(
        'Chat: Release notes draft',
      );
      expect(formatCallerLabel('wiki', 'self — ingestion')).to.equal('Wiki: self — ingestion');
      expect(formatCallerLabel('workspace-chat', 'Billing')).to.equal('Workspace: Billing');
      expect(formatCallerLabel('task', 'Billing — Sync pricing')).to.equal(
        'Task: Billing — Sync pricing',
      );
    });
  });

  describe('resolveCallerIdentity', () => {
    let store: ThreadStore;
    let dir: string;

    before(() => ({ store, dir } = makeStore()));
    after(() => {
      store.close();
      rmSync(dir, { recursive: true });
    });

    const cases: { type: ThreadType; title: string }[] = [
      { type: 'chat', title: 'A chat thread' },
      { type: 'wiki', title: 'A wiki thread' },
      { type: 'workspace-chat', title: 'A workspace chat thread' },
      { type: 'task', title: 'A task run thread' },
    ];

    for (const { type, title } of cases) {
      it(`resolves kind and label for a '${type}' thread`, () => {
        const threadId = `thread-${type}`;
        store.upsertThreadOnFirstMessage(threadId, title, type);

        const identity = resolveCallerIdentity(store, threadId);
        expect(identity).to.deep.equal({
          threadId,
          kind: type,
          label: formatCallerLabel(type, title),
        });
      });
    }

    it('falls back to chat/Untitled for an unknown threadId', () => {
      const identity = resolveCallerIdentity(store, 'does-not-exist');
      expect(identity).to.deep.equal({
        threadId: 'does-not-exist',
        kind: 'chat',
        label: 'Chat: Untitled',
      });
    });
  });
});
