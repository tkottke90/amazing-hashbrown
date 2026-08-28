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

describe('agents/tools/wiki-add-cross-link', () => {
  let dir: string;
  let registry: WikiRegistry;
  let store: WorkspaceStore;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wiki-add-cross-link-test-'));
    store = new WorkspaceStore(openDatabase(join(dir, 'test.db')));
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

  it('rejects a forbidden wiki before adding the link', async () => {
    const tool = makeWikiAddCrossLinkTool('test-wiki', registry, store);
    const result = await tool.invoke({
      wikiId: 'other-wiki',
      fromPage: 'entities/a.md',
      toPage: 'entities/b.md',
    });
    expect(result).to.equal(wikiWriteForbiddenMessage('other-wiki', 'test-wiki'));

    const wiki = await registry.load('test-wiki');
    const page = await wiki.readPage('entities/a.md');
    expect(page.content).to.not.contain('## Related Pages');
  });

  it('adds the link when the wiki matches allowedWikiId', async () => {
    const tool = makeWikiAddCrossLinkTool('test-wiki', registry, store);
    const result = await tool.invoke({
      wikiId: 'test-wiki',
      fromPage: 'entities/a.md',
      toPage: 'entities/b.md',
    });
    expect(result).to.contain('Added cross-link');

    const wiki = await registry.load('test-wiki');
    const page = await wiki.readPage('entities/a.md');
    expect(page.content).to.contain('## Related Pages');
    expect(page.content).to.contain('[[entities/b]]');
  });

  it('applies no restriction when allowedWikiId is undefined', async () => {
    const wiki = await registry.load('test-wiki');
    await wiki.commitPage({
      type: 'entity',
      title: 'C',
      tags: [],
      sources: [],
      body: 'Page C. [[a]] [[dns]]',
    });

    const tool = makeWikiAddCrossLinkTool(undefined, registry, store);
    const result = await tool.invoke({
      wikiId: 'test-wiki',
      fromPage: 'entities/c.md',
      toPage: 'entities/b.md',
    });
    expect(result).to.contain('Added cross-link');
  });

  it('reports an unregistered wiki even when allowedWikiId is set', async () => {
    const tool = makeWikiAddCrossLinkTool('test-wiki', registry, store);
    const result = await tool.invoke({
      wikiId: 'does-not-exist',
      fromPage: 'entities/a.md',
      toPage: 'entities/b.md',
    });
    expect(result).to.equal(
      'Wiki "does-not-exist" is not registered. Use wiki_locate to find available domains.',
    );
  });

  it('rejects an archived domain before adding the link', async () => {
    const tool = makeWikiAddCrossLinkTool(undefined, registry, store);
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
