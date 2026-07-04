import { expect } from 'chai';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWikiRegistry } from '../src/index.js';

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

  it('saves routing notes and round-trips them', async () => {
    const root = await tmpRoot();
    const registry = await createWikiRegistry({ wikiRoot: root });
    await registry.saveRoutingNotes(['cardio -> fitness']);
    const reloaded = await createWikiRegistry({ wikiRoot: root });
    expect(reloaded.routingNotes()).to.deep.equal(['cardio -> fitness']);
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
