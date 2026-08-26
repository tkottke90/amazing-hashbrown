import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createWikiRegistry, type WikiRegistry } from '@tkottke90/llm-wiki';
import { makeWikiAddCrossLinkTool } from './wiki-add-cross-link.tool.js';
import { wikiWriteForbiddenMessage } from './wiki-write-guard.js';

describe('agents/tools/wiki-add-cross-link', () => {
  let dir: string;
  let registry: WikiRegistry;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wiki-add-cross-link-test-'));
    registry = await createWikiRegistry({ wikiRoot: join(dir, 'wikiroot') });
    await registry.create({ id: 'test-wiki', domain: 'testing', tags: ['test'] });
    await registry.create({ id: 'other-wiki', domain: 'other', tags: [] });

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
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a forbidden wiki before adding the link', async () => {
    const tool = makeWikiAddCrossLinkTool('test-wiki', registry);
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
    const tool = makeWikiAddCrossLinkTool('test-wiki', registry);
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

    const tool = makeWikiAddCrossLinkTool(undefined, registry);
    const result = await tool.invoke({
      wikiId: 'test-wiki',
      fromPage: 'entities/c.md',
      toPage: 'entities/b.md',
    });
    expect(result).to.contain('Added cross-link');
  });

  it('reports an unregistered wiki even when allowedWikiId is set', async () => {
    const tool = makeWikiAddCrossLinkTool('test-wiki', registry);
    const result = await tool.invoke({
      wikiId: 'does-not-exist',
      fromPage: 'entities/a.md',
      toPage: 'entities/b.md',
    });
    expect(result).to.equal(
      'Wiki "does-not-exist" is not registered. Use wiki_locate to find available domains.',
    );
  });
});
