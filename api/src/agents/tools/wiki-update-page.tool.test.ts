import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { createWikiRegistry, type WikiRegistry } from '@tkottke90/llm-wiki';
import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { setActiveSseWriter, clearActiveSseWriter } from '../active-sse-writer.js';
import { createWikiPage } from '../../services/wiki-write.js';
import { makeWikiUpdatePageTool } from './wiki-update-page.tool.js';

const THREAD_ID = 'test-thread';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invokeConfig(): any {
  return { configurable: { thread_id: THREAD_ID }, toolCallId: 'call-1' };
}

describe('agents/tools/wiki-update-page', () => {
  let store: WorkspaceStore;
  let registry: WikiRegistry;
  let dir: string;
  let sseEvents: ChatSSEEvent[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wiki-update-page-tool-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    store = new WorkspaceStore(db);
    registry = await createWikiRegistry({ wikiRoot: join(dir, 'wikiroot') });
    await registry.create({ id: 'test-wiki', domain: 'testing', tags: [] });
    sseEvents = [];
    setActiveSseWriter(THREAD_ID, (event) => sseEvents.push(event));
  });

  afterEach(() => {
    clearActiveSseWriter(THREAD_ID);
    rmSync(dir, { recursive: true, force: true });
  });

  it("updates a page and emits a wiki_updated event carrying the page's real title (not the raw path), pageKind updated, and the page path", async () => {
    const created = await createWikiPage(
      {
        wikiId: 'test-wiki',
        title: 'Host Settings',
        content: 'v1.',
        section: 'entity',
      },
      registry,
      undefined,
      store,
    );
    expect(created.status).to.equal('written');
    if (created.status !== 'written') return;

    const tool = makeWikiUpdatePageTool(undefined, registry, store);
    await tool.invoke(
      { wikiId: 'test-wiki', path: created.result.path, content: 'v2.' },
      invokeConfig(),
    );

    expect(sseEvents).to.have.length(1);
    expect(sseEvents[0]).to.deep.equal({
      type: 'wiki_updated',
      pageTitle: 'Host Settings',
      pageKind: 'updated',
      wikiName: 'test-wiki',
      path: created.result.path,
    });
  });

  it('does not emit a wiki_updated event when the update target is not found', async () => {
    const tool = makeWikiUpdatePageTool(undefined, registry, store);

    const result = await tool.invoke(
      { wikiId: 'test-wiki', path: 'entities/does-not-exist.md', content: 'v2.' },
      invokeConfig(),
    );

    expect(result).to.be.a('string');
    expect(result as unknown as string).to.include('not found');
    expect(sseEvents).to.have.length(0);
  });
});
