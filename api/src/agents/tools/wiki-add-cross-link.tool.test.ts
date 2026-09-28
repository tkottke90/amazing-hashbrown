import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { createWikiRegistry, type WikiRegistry } from '@tkottke90/llm-wiki';
import { makeWikiAddCrossLinkTool } from './wiki-add-cross-link.tool.js';
import { wikiWriteForbiddenMessage } from './wiki-write-guard.js';
import { wikiArchivedMessage } from '../../services/wiki-archive-guard.js';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { ThreadStore } from '../../services/thread-store.js';

const LOCKED_THREAD = 'locked-thread';

// A workspace-chat thread whose workspace is bound to test-wiki, so the
// tool's write scope is locked to it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lockedConfig(): any {
  return { configurable: { thread_id: LOCKED_THREAD } };
}

describe('agents/tools/wiki-add-cross-link', () => {
  let dir: string;
  let registry: WikiRegistry;
  let store: WorkspaceStore;
  let threadStore: ThreadStore;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wiki-add-cross-link-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    store = new WorkspaceStore(db);
    threadStore = new ThreadStore(db);
    const bound = store.createWorkspace({
      name: 'bound',
      location: join(dir, 'bound-ws'),
      wikiId: 'test-wiki',
    });
    threadStore.upsertThreadOnFirstMessage(LOCKED_THREAD, 'bound', 'workspace-chat');
    store.patchWorkspace(bound.id, { threadId: LOCKED_THREAD });
    registry = await createWikiRegistry({ wikiRoot: join(dir, 'wikiroot') });
    await registry.create({ id: 'test-wiki', domain: 'testing', tags: ['test'] });
    await registry.create({ id: 'other-wiki', domain: 'other', tags: [] });
    await registry.create({ id: 'archived-wiki', domain: 'archived', tags: [] });

    const wiki = await registry.load('test-wiki');
    await wiki.commitPage({
      type: 'entity',
      title: 'A',
      tags: [],
      sources: [],
      body: 'Page A. [[b]] [[dns]]',
    });
    await wiki.commitPage({
      type: 'entity',
      title: 'B',
      tags: [],
      sources: [],
      body: 'Page B. [[a]] [[dns]]',
    });

    const archivedWiki = await registry.load('archived-wiki');
    await archivedWiki.commitPage({
      type: 'entity',
      title: 'D',
      tags: [],
      sources: [],
      body: 'Page D. [[e]]',
    });
    await archivedWiki.commitPage({
      type: 'entity',
      title: 'E',
      tags: [],
      sources: [],
      body: 'Page E. [[d]]',
    });
    const archivedId = randomUUID();
    store.createProject({
      id: archivedId,
      name: 'Archived Project',
      location: join(dir, 'archived-ws'),
      winCondition: 'done',
      wikiId: 'archived-wiki',
    });
    store.closeProject(archivedId, 'close');
    store.completeClose(archivedId, 'closed');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a wiki outside a locked workspace scope before adding the link', async () => {
    const tool = makeWikiAddCrossLinkTool(registry, store, threadStore);
    const result = await tool.invoke(
      {
        wikiId: 'other-wiki',
        fromPage: 'entities/a.md',
        toPage: 'entities/b.md',
      },
      lockedConfig(),
    );
    expect(result).to.equal(wikiWriteForbiddenMessage('other-wiki', 'test-wiki'));

    const wiki = await registry.load('test-wiki');
    const page = await wiki.readPage('entities/a.md');
    expect(page.content).to.not.contain('## Related Pages');
  });

  it('adds the link when the wiki is the locked one', async () => {
    const tool = makeWikiAddCrossLinkTool(registry, store, threadStore);
    const result = await tool.invoke(
      {
        wikiId: 'test-wiki',
        fromPage: 'entities/a.md',
        toPage: 'entities/b.md',
      },
      lockedConfig(),
    );
    expect(result).to.contain('Added cross-link');

    const wiki = await registry.load('test-wiki');
    const page = await wiki.readPage('entities/a.md');
    expect(page.content).to.contain('## Related Pages');
    expect(page.content).to.contain('[[entities/b]]');
  });

  it('applies no restriction when invoked without a thread (evals/tests)', async () => {
    const wiki = await registry.load('test-wiki');
    await wiki.commitPage({
      type: 'entity',
      title: 'C',
      tags: [],
      sources: [],
      body: 'Page C. [[a]] [[dns]]',
    });

    const tool = makeWikiAddCrossLinkTool(registry, store, threadStore);
    const result = await tool.invoke({
      wikiId: 'test-wiki',
      fromPage: 'entities/c.md',
      toPage: 'entities/b.md',
    });
    expect(result).to.contain('Added cross-link');
  });

  it('reports an unregistered wiki even inside a locked scope', async () => {
    const tool = makeWikiAddCrossLinkTool(registry, store, threadStore);
    const result = await tool.invoke(
      {
        wikiId: 'does-not-exist',
        fromPage: 'entities/a.md',
        toPage: 'entities/b.md',
      },
      lockedConfig(),
    );
    expect(result).to.equal(
      'Wiki "does-not-exist" is not registered. Use wiki_locate to find available domains.',
    );
  });

  it('writes a wikiId:pagePath toPage through unchanged for a cross-wiki reference', async () => {
    const wiki = await registry.load('test-wiki');
    await wiki.commitPage({
      type: 'entity',
      title: 'F',
      tags: [],
      sources: [],
      body: 'Page F. [[dns]]',
    });

    const tool = makeWikiAddCrossLinkTool(registry, store, threadStore);
    const result = await tool.invoke(
      {
        wikiId: 'test-wiki',
        fromPage: 'entities/f.md',
        toPage: 'other-wiki:entities/b.md',
      },
      lockedConfig(),
    );
    expect(result).to.contain('Added cross-link');

    const page = await wiki.readPage('entities/f.md');
    expect(page.content).to.contain('[[other-wiki:entities/b]]');
  });

  it('rejects a wiki bound to another workspace from an unbound workspace thread [orchestration]', async () => {
    // #202: an unbound workspace goes looking, but never into another
    // workspace's wiki (test-wiki is bound to the "bound" workspace).
    const unbound = store.createWorkspace({ name: 'unbound', location: join(dir, 'unbound-ws') });
    threadStore.upsertThreadOnFirstMessage('unbound-thread', 'unbound', 'workspace-chat');
    store.patchWorkspace(unbound.id, { threadId: 'unbound-thread' });

    const tool = makeWikiAddCrossLinkTool(registry, store, threadStore);
    const result = await tool.invoke(
      { wikiId: 'test-wiki', fromPage: 'entities/b.md', toPage: 'entities/a.md' },
      { configurable: { thread_id: 'unbound-thread' } },
    );
    expect(result).to.contain('belongs to another workspace');
  });

  it('rejects an archived domain before adding the link', async () => {
    const tool = makeWikiAddCrossLinkTool(registry, store, threadStore);
    const result = await tool.invoke({
      wikiId: 'archived-wiki',
      fromPage: 'entities/d.md',
      toPage: 'entities/e.md',
    });
    expect(result).to.equal(wikiArchivedMessage('archived-wiki'));

    const wiki = await registry.load('archived-wiki');
    const page = await wiki.readPage('entities/d.md');
    expect(page.content).to.not.contain('## Related Pages');
  });
});
