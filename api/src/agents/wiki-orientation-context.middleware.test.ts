import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { SystemMessage } from '@langchain/core/messages';
import { openDatabase, type SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { bootThreadStore, getThreadStore } from '../services/thread-store.js';
import { createWikiOrientationContextMiddleware } from './wiki-orientation-context.middleware.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeRequest(threadId?: string, systemText = 'base prompt'): any {
  return {
    runtime: { configurable: threadId ? { thread_id: threadId } : {} },
    systemMessage: new SystemMessage(systemText),
  };
}

async function runMiddleware(
  middleware: ReturnType<typeof createWikiOrientationContextMiddleware>,
  request: unknown,
): Promise<string> {
  let systemContent = '';
  const handler = async (req: { systemMessage: { content: unknown } }) => {
    systemContent = req.systemMessage.content as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return undefined as any;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (middleware as any).wrapModelCall(request, handler);
  return systemContent;
}

describe('agents/wiki-orientation-context.middleware', () => {
  let dir: string;
  let db: SqliteDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wiki-orientation-context-middleware-test-'));
    db = openDatabase(join(dir, 'test.db'));
    bootThreadStore(db);
    getThreadStore().upsertThreadOnFirstMessage('t1', 'hi');
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is a no-op when there is no thread id [unit]', async () => {
    const middleware = createWikiOrientationContextMiddleware(async () => {
      throw new Error('should not be called');
    });
    const systemContent = await runMiddleware(middleware, fakeRequest(undefined));
    expect(systemContent).to.equal('base prompt');
  });

  it('is a no-op when the thread has no active wiki [unit]', async () => {
    const middleware = createWikiOrientationContextMiddleware(async () => {
      throw new Error('should not be called');
    });
    const systemContent = await runMiddleware(middleware, fakeRequest('t1'));
    expect(systemContent).to.equal('base prompt');
  });

  it('appends the formatted orientation block fresh from wiki.orient() when active [unit]', async () => {
    getThreadStore().setActiveWikiId('t1', 'user');
    const fakeRegistry = {
      load: async (id: string) => {
        expect(id).to.equal('user');
        return {
          orient: async () => ({ schema: 'tags: []', index: 'index.md', recentLog: [] }),
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const middleware = createWikiOrientationContextMiddleware(async () => fakeRegistry);

    const systemContent = await runMiddleware(middleware, fakeRequest('t1'));

    expect(systemContent).to.include('base prompt');
    expect(systemContent).to.include('# Wiki Orientation: user');
    expect(systemContent).to.include('## Schema\ntags: []');
  });

  it('degrades silently when the stored wiki id no longer resolves [unit]', async () => {
    getThreadStore().setActiveWikiId('t1', 'deleted-domain');
    const fakeRegistry = {
      load: async () => {
        throw new Error('domain not found');
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const middleware = createWikiOrientationContextMiddleware(async () => fakeRegistry);

    const systemContent = await runMiddleware(middleware, fakeRequest('t1'));
    expect(systemContent).to.equal('base prompt');
  });
});
