import { expect } from 'chai';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWikiRegistry } from '../src/index.js';
import { NullEmbeddingProvider } from '../src/providers/null.js';

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wiki-root-'));
}

describe('WikiRegistry', () => {
  it('starts empty when no registry.json exists', async () => {
    const registry = await createWikiRegistry({ wikiRoot: await tmpRoot() });
    expect(registry.list()).to.have.length(0);
  });

  it('creates a wiki, scaffolds it, and persists registry.json', async () => {
    const root = await tmpRoot();
    const registry = await createWikiRegistry({ wikiRoot: root });
    await registry.create({
      id: 'homelab',
      domain: 'infrastructure',
      tags: ['dns', 'proxy'],
      routingNotes: ['dns, proxy -> homelab'],
    });

    // Scaffolded on disk
    await fs.access(path.join(root, 'homelab', 'SCHEMA.md'));

    // Persisted and reloadable
    const raw = JSON.parse(await fs.readFile(path.join(root, 'registry.json'), 'utf8'));
    expect(raw.wikis[0].id).to.equal('homelab');
    expect(raw.routingNotes).to.include('dns, proxy -> homelab');

    const reloaded = await createWikiRegistry({ wikiRoot: root });
    expect(reloaded.list().map((w) => w.id)).to.deep.equal(['homelab']);
  });

  it('rejects duplicate ids', async () => {
    const registry = await createWikiRegistry({ wikiRoot: await tmpRoot() });
    await registry.create({ id: 'a', domain: 'x' });
    let threw = false;
    try {
      await registry.create({ id: 'a', domain: 'y' });
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });

  it('resolves context to a registered wiki', async () => {
    const registry = await createWikiRegistry({ wikiRoot: await tmpRoot() });
    await registry.create({
      id: 'homelab',
      domain: 'infrastructure',
      tags: ['dns'],
      routingNotes: ['reverse proxy, dns -> homelab'],
    });
    const result = registry.resolve('help me configure the reverse proxy');
    expect(result).to.have.property('id', 'homelab');
  });

  it('returns no_match when nothing scores', async () => {
    const registry = await createWikiRegistry({ wikiRoot: await tmpRoot() });
    await registry.create({ id: 'homelab', domain: 'infrastructure', tags: ['dns'] });
    const result = registry.resolve('completely unrelated topic xyzzy');
    expect(result).to.have.property('noMatch', true);
  });

  it('loads a wiki instance by id', async () => {
    const root = await tmpRoot();
    const registry = await createWikiRegistry({ wikiRoot: root });
    await registry.create({ id: 'homelab', domain: 'infrastructure', tags: ['dns'] });
    const wiki = await registry.load('homelab');
    expect(wiki.basePath).to.equal(path.join(root, 'homelab'));
  });

  it('threads a registry-level embeddingProvider into every wiki it creates and loads', async () => {
    const root = await tmpRoot();
    const provider = new NullEmbeddingProvider();
    const registry = await createWikiRegistry({ wikiRoot: root, embeddingProvider: provider });

    // An empty wiki short-circuits semanticSearch before ever touching the
    // provider (see LlmWiki.semanticSearch's contentPaths.length === 0
    // check) — commit a page first so the provider-required path is
    // actually exercised, not just the vacuous empty-wiki case.
    const page = {
      type: 'entity' as const,
      title: 'Router',
      tags: [],
      sources: [],
      body: 'A router forwards network packets.',
    };

    // create() must pass it through too, not just load() — semantic/hybrid
    // search must work immediately on a freshly-created wiki, not just after
    // a reload.
    const created = await registry.create({ id: 'homelab', domain: 'infrastructure' });
    await created.commitPage(page);
    const createdResults = await created.semanticSearch('router', { mode: 'semantic' });
    expect(createdResults).to.have.length(1);

    const loaded = await registry.load('homelab');
    const loadedResults = await loaded.semanticSearch('router', { mode: 'semantic' });
    expect(loadedResults).to.have.length(1);
  });

  it('leaves semantic/hybrid search unavailable when no embeddingProvider is configured', async () => {
    const registry = await createWikiRegistry({ wikiRoot: await tmpRoot() });
    const wiki = await registry.create({ id: 'homelab', domain: 'infrastructure' });
    // Non-empty wiki required — an empty wiki short-circuits before the
    // provider check (see the test above).
    await wiki.commitPage({
      type: 'entity',
      title: 'Router',
      tags: [],
      sources: [],
      body: 'A router forwards network packets.',
    });

    let err: Error | undefined;
    try {
      await wiki.semanticSearch('anything', { mode: 'semantic' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.be.instanceOf(Error);
    expect(err!.message).to.include('embeddingProvider');
  });

  it('saves routing notes and round-trips them', async () => {
    const root = await tmpRoot();
    const registry = await createWikiRegistry({ wikiRoot: root });
    await registry.saveRoutingNotes(['cardio -> fitness']);
    const reloaded = await createWikiRegistry({ wikiRoot: root });
    expect(reloaded.routingNotes()).to.deep.equal(['cardio -> fitness']);
  });

  it('registers a wiki with readOnly status and includes it in the default listing', async () => {
    const root = await tmpRoot();
    const registry = await createWikiRegistry({ wikiRoot: root });
    // Scaffold the directory via create(), then re-register as readOnly.
    await registry.create({ id: 'docs', domain: 'documentation' });
    await registry.remove('docs');
    await registry.register('docs', { status: 'readOnly' });

    const listed = registry.list();
    expect(listed.map((w) => w.id)).to.include('docs');
    expect(listed.find((w) => w.id === 'docs')?.status).to.equal('readOnly');
    // readOnly wikis must NOT appear in an active-only filter
    expect(listed.filter((w) => w.status === 'active').map((w) => w.id)).to.not.include('docs');
    // But archived wikis remain hidden in the default listing
    const archivedShown = registry.list(true).length;
    expect(archivedShown).to.be.greaterThanOrEqual(listed.length);
  });

  it('persists readOnly status through registry.json round-trip', async () => {
    const root = await tmpRoot();
    const registry = await createWikiRegistry({ wikiRoot: root });
    await registry.create({ id: 'docs', domain: 'documentation' });
    await registry.remove('docs');
    await registry.register('docs', { status: 'readOnly' });

    const reloaded = await createWikiRegistry({ wikiRoot: root });
    const entry = reloaded.list().find((w) => w.id === 'docs');
    expect(entry?.status).to.equal('readOnly');
  });

  it('lints through the registry and can flag registry_sync drift', async () => {
    const root = await tmpRoot();
    const registry = await createWikiRegistry({ wikiRoot: root });
    await registry.create({ id: 'homelab', domain: 'infrastructure', tags: ['dns'] });
    // A stray wiki dir on disk that is not registered.
    await fs.mkdir(path.join(root, 'stray'), { recursive: true });
    await fs.writeFile(path.join(root, 'stray', 'SCHEMA.md'), '# Wiki Schema\n');

    const report = await registry.lint('homelab');
    const sync = report.checks.filter((c) => c.check === 'registry_sync');
    expect(sync.length).to.equal(1);
    expect(sync[0]?.message).to.contain('stray');
  });
});
