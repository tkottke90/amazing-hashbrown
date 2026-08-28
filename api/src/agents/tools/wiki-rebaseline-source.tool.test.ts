import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import matter from 'gray-matter';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { createWikiRegistry, type WikiRegistry } from '@tkottke90/llm-wiki';
import { makeWikiRebaselineSourceTool } from './wiki-rebaseline-source.tool.js';
import { wikiWriteForbiddenMessage } from './wiki-write-guard.js';
import { wikiArchivedMessage } from '../../services/wiki-archive-guard.js';
import { WorkspaceStore } from '../../services/workspace-store.js';

async function rawSha256(registry: WikiRegistry, wikiId: string, relPath: string) {
  const wiki = await registry.load(wikiId);
  const raw = readFileSync(join(wiki.basePath, relPath), 'utf8');
  return String(matter(raw).data.sha256 ?? '');
}

describe('agents/tools/wiki-rebaseline-source', () => {
  let dir: string;
  let registry: WikiRegistry;
  let store: WorkspaceStore;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wiki-rebaseline-source-test-'));
    store = new WorkspaceStore(openDatabase(join(dir, 'test.db')));
    registry = await createWikiRegistry({ wikiRoot: join(dir, 'wikiroot') });
    await registry.create({ id: 'test-wiki', domain: 'testing', tags: ['test'] });
    await registry.create({ id: 'other-wiki', domain: 'other', tags: [] });
    await registry.create({ id: 'archived-wiki', domain: 'archived', tags: [] });

    const wiki = await registry.load('test-wiki');
    await wiki.saveRawSource({
      path: 'raw/note.md',
      sourceUrl: 'https://example.com/note',
      sha256: 'stale-placeholder',
      content: 'raw body',
    });

    const archivedWiki = await registry.load('archived-wiki');
    await archivedWiki.saveRawSource({
      path: 'raw/note.md',
      sourceUrl: 'https://example.com/note',
      sha256: 'stale-placeholder',
      content: 'raw body',
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

  it('rejects a forbidden wiki before rebaselining', async () => {
    const tool = makeWikiRebaselineSourceTool('test-wiki', registry, store);
    const result = await tool.invoke({ wikiId: 'other-wiki', rawFilePath: 'raw/note.md' });
    expect(result).to.equal(wikiWriteForbiddenMessage('other-wiki', 'test-wiki'));
    expect(await rawSha256(registry, 'test-wiki', 'raw/note.md')).to.equal('stale-placeholder');
  });

  it('rebaselines when the wiki matches allowedWikiId', async () => {
    const tool = makeWikiRebaselineSourceTool('test-wiki', registry, store);
    const result = await tool.invoke({ wikiId: 'test-wiki', rawFilePath: 'raw/note.md' });
    expect(result).to.contain('Rebaselined raw source');
    expect(await rawSha256(registry, 'test-wiki', 'raw/note.md')).to.not.equal('stale-placeholder');
  });

  it('applies no restriction when allowedWikiId is undefined', async () => {
    const wiki = await registry.load('test-wiki');
    await wiki.saveRawSource({
      path: 'raw/other-note.md',
      sourceUrl: 'https://example.com/other',
      sha256: 'stale-placeholder-2',
      content: 'raw body two',
    });

    const tool = makeWikiRebaselineSourceTool(undefined, registry, store);
    const result = await tool.invoke({ wikiId: 'test-wiki', rawFilePath: 'raw/other-note.md' });
    expect(result).to.contain('Rebaselined raw source');
  });

  it('still reports a missing raw file once the wiki is allowed', async () => {
    const tool = makeWikiRebaselineSourceTool('test-wiki', registry, store);
    const result = await tool.invoke({ wikiId: 'test-wiki', rawFilePath: 'raw/nope.md' });
    expect(result).to.equal('Raw file not found: raw/nope.md');
  });

  it('rejects an archived domain before rebaselining', async () => {
    const tool = makeWikiRebaselineSourceTool(undefined, registry, store);
    const result = await tool.invoke({ wikiId: 'archived-wiki', rawFilePath: 'raw/note.md' });
    expect(result).to.equal(wikiArchivedMessage('archived-wiki'));
    expect(await rawSha256(registry, 'archived-wiki', 'raw/note.md')).to.equal('stale-placeholder');
  });
});
