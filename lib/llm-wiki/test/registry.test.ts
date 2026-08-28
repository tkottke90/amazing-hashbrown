import { expect } from 'chai';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
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

  it('writes metadata as YAML frontmatter into the scaffolded index.md', async () => {
    const root = await tmpRoot();
    const registry = await createWikiRegistry({ wikiRoot: root });
    await registry.create({
      id: 'project-abc',
      domain: 'my-project',
      metadata: { type: 'ephemeral', status: 'active' },
    });

    const raw = await fs.readFile(path.join(root, 'project-abc', 'index.md'), 'utf8');
    const parsed = matter(raw);
    expect(parsed.data).to.deep.equal({ type: 'ephemeral', status: 'active' });
    // The catalog body must survive the frontmatter wrap untouched.
    expect(parsed.content).to.contain('# Wiki Index');
    expect(parsed.content).to.contain('## Entities');
  });

  it('leaves index.md frontmatter-free when no metadata is given', async () => {
    const root = await tmpRoot();
    const registry = await createWikiRegistry({ wikiRoot: root });
    await registry.create({ id: 'homelab', domain: 'infrastructure' });

    const raw = await fs.readFile(path.join(root, 'homelab', 'index.md'), 'utf8');
    expect(raw.startsWith('---')).to.equal(false);
    expect(raw).to.contain('# Wiki Index');
  });

  it('destroy() deletes the wiki directory and its registry entry', async () => {
    const root = await tmpRoot();
    const registry = await createWikiRegistry({ wikiRoot: root });
    await registry.create({ id: 'project-abc', domain: 'my-project' });

    await registry.destroy('project-abc');

    let dirGone = false;
    try {
      await fs.access(path.join(root, 'project-abc'));
    } catch {
      dirGone = true;
    }
    expect(dirGone, 'wiki directory should be removed from disk').to.equal(true);
    expect(registry.list()).to.have.length(0);
    const reloaded = await createWikiRegistry({ wikiRoot: root });
    expect(reloaded.list()).to.have.length(0);
  });

  it('destroy() removes a stray unregistered directory without throwing', async () => {
    // Rollback path: LlmWiki.create scaffolded the dir but register() never ran.
    const root = await tmpRoot();
    const registry = await createWikiRegistry({ wikiRoot: root });
    await fs.mkdir(path.join(root, 'orphan'), { recursive: true });
    await fs.writeFile(path.join(root, 'orphan', 'SCHEMA.md'), '# Wiki Schema\n');

    await registry.destroy('orphan');

    let dirGone = false;
    try {
      await fs.access(path.join(root, 'orphan'));
    } catch {
      dirGone = true;
    }
    expect(dirGone, 'orphan directory should be removed').to.equal(true);
  });

  it('destroy() refuses an unregistered id that escapes the wiki root', async () => {
    const root = await tmpRoot();
    const outside = path.join(path.dirname(root), `outside-${path.basename(root)}`);
    await fs.mkdir(outside, { recursive: true });
    const registry = await createWikiRegistry({ wikiRoot: root });

    await registry.destroy(`../${path.basename(outside)}`);

    // The sibling directory outside the wiki root must survive.
    await fs.access(outside);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('archive() marks the entry archived and excludes it from list() by default', async () => {
    const root = await tmpRoot();
    const registry = await createWikiRegistry({ wikiRoot: root });
    await registry.create({ id: 'project-abc', domain: 'my-project' });

    await registry.archive('project-abc');

    expect(registry.list()).to.have.length(0);
    expect(registry.list(true)).to.have.length(1);
    expect(registry.list(true)[0]?.status).to.equal('archived');

    // Persists across a reload.
    const reloaded = await createWikiRegistry({ wikiRoot: root });
    expect(reloaded.list()).to.have.length(0);
    expect(reloaded.list(true)[0]?.status).to.equal('archived');
  });

  it('archive() leaves the wiki still load()-able by id', async () => {
    const root = await tmpRoot();
    const registry = await createWikiRegistry({ wikiRoot: root });
    await registry.create({ id: 'project-abc', domain: 'my-project' });

    await registry.archive('project-abc');

    const wiki = await registry.load('project-abc');
    const { schema } = await wiki.orient();
    expect(schema).to.contain('my-project');
  });

  it('archive() throws for an unregistered id', async () => {
    const root = await tmpRoot();
    const registry = await createWikiRegistry({ wikiRoot: root });
    let threw = false;
    try {
      await registry.archive('nope');
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
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
