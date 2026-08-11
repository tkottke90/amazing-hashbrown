import { expect } from 'chai';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LlmWiki } from '../src/index.js';

async function tmpWikiPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-wiki-'));
  return path.join(dir, 'wiki');
}

async function newWiki(): Promise<LlmWiki> {
  return LlmWiki.create({
    path: await tmpWikiPath(),
    name: 'homelab',
    domain: 'infrastructure and services',
    tags: ['host', 'service', 'dns'],
  });
}

describe('LlmWiki.create', () => {
  it('scaffolds directories and skeleton files', async () => {
    const wiki = await newWiki();
    for (const rel of ['SCHEMA.md', 'index.md', 'log.md', 'entities', 'raw']) {
      await fs.access(path.join(wiki.basePath, rel)); // throws if missing
    }
    const { schema } = await wiki.orient();
    expect(schema).to.contain('infrastructure and services');
  });

  it('loads the tag taxonomy so unknown tags warn on write', async () => {
    const wiki = await newWiki();
    const result = await wiki.commitPage({
      type: 'entity',
      title: 'Router',
      tags: ['bogus-tag'],
      sources: [],
      body: 'A router. Links: [[proxy]] [[dns]]',
    });
    expect(result.warnings.map((w) => w.code)).to.include('unknown-tag');
  });
});

describe('LlmWiki.commitPage', () => {
  it('writes a page, updates the index, and logs the ingest', async () => {
    const wiki = await newWiki();
    const result = await wiki.commitPage({
      type: 'entity',
      title: 'Proxy',
      tags: ['service'],
      sources: ['raw/x.md'],
      summary: 'the reverse proxy',
      body: 'The proxy. See [[dns]] and [[host]].',
    });
    expect(result.created).to.equal(true);
    expect(result.path).to.equal('entities/proxy.md');

    const { index, recentLog } = await wiki.orient();
    expect(index).to.contain('[[entities/proxy|Proxy]] — the reverse proxy');
    expect(index).to.contain('Total pages: 1');
    expect(recentLog.at(-1)?.subject).to.equal('Proxy');
  });

  it('warns when a page has fewer than two outbound links', async () => {
    const wiki = await newWiki();
    const result = await wiki.commitPage({
      type: 'concept',
      title: 'Lonely',
      tags: ['service'],
      sources: [],
      body: 'No links at all.',
    });
    expect(result.warnings.map((w) => w.code)).to.include('few-wikilinks');
  });

  it('upserts: second commit updates and merges sources, bumps to update', async () => {
    const wiki = await newWiki();
    await wiki.commitPage({
      type: 'entity',
      title: 'Host',
      tags: ['host'],
      sources: ['raw/a.md'],
      body: 'v1 [[dns]] [[proxy]]',
    });
    const second = await wiki.commitPage({
      type: 'entity',
      title: 'Host',
      tags: ['host'],
      sources: ['raw/b.md'],
      body: 'v2 [[dns]] [[proxy]]',
    });
    expect(second.created).to.equal(false);

    const p = await wiki.readPage('entities/host.md');
    expect(p.content).to.contain('v2');
    expect(p.frontmatter.sources).to.have.members(['raw/a.md', 'raw/b.md']);
  });

  it('throws on a blank title', async () => {
    const wiki = await newWiki();
    let threw = false;
    try {
      await wiki.commitPage({ type: 'entity', title: '  ', tags: [], sources: [], body: 'x' });
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });
});

describe('LlmWiki ingest flow', () => {
  it('preps a source: hash, suggested path, new/drift status', async () => {
    const wiki = await newWiki();
    const prep = await wiki.ingestPrep({
      content: '# Article\nSome content about DNS.',
      url: 'https://example.com/dns',
    });
    expect(prep.sha256).to.have.length(64);
    expect(prep.isNew).to.equal(true);
    expect(prep.drift).to.equal(false);
    expect(prep.suggestedRawPath).to.contain('raw/articles/');
  });

  it('detects re-ingest and drift after a raw source is saved', async () => {
    const wiki = await newWiki();
    const url = 'https://example.com/dns';
    const first = await wiki.ingestPrep({ content: 'body one', url });
    await wiki.saveRawSource({ content: 'body one', sourceUrl: url, sha256: first.sha256 });

    const unchanged = await wiki.ingestPrep({ content: 'body one', url });
    expect(unchanged.isNew).to.equal(false);
    expect(unchanged.drift).to.equal(false);

    const changed = await wiki.ingestPrep({ content: 'body two (edited)', url });
    expect(changed.isNew).to.equal(false);
    expect(changed.drift).to.equal(true);
  });

  it('finds existing pages by title match', async () => {
    const wiki = await newWiki();
    await wiki.commitPage({
      type: 'entity',
      title: 'DNS Server',
      tags: ['dns'],
      sources: [],
      body: 'Runs unbound. [[host]] [[proxy]]',
    });
    const prep = await wiki.ingestPrep({
      content: 'about dns',
      title: 'DNS Server',
      keywords: ['dns'],
    });
    expect(prep.existingPages).to.include('entities/dns-server.md');
  });
});

describe('LlmWiki.addCrossLink', () => {
  it('adds a Related Pages link and bumps updated', async () => {
    const wiki = await newWiki();
    await wiki.commitPage({
      type: 'entity',
      title: 'A',
      tags: ['host'],
      sources: [],
      body: 'Page A. [[b]] [[dns]]',
    });
    const result = await wiki.addCrossLink({
      fromPage: 'entities/a.md',
      toPage: 'entities/b.md',
    });
    expect(result.warnings).to.have.length(0);
    const page = await wiki.readPage('entities/a.md');
    expect(page.content).to.contain('## Related Pages');
    expect(page.content).to.contain('[[entities/b]]');
  });
});

describe('LlmWiki.lint', () => {
  it('reports broken links from a committed page', async () => {
    const wiki = await newWiki();
    await wiki.commitPage({
      type: 'entity',
      title: 'A',
      tags: ['host'],
      sources: [],
      body: 'points to [[does-not-exist]] and [[dns]] [[proxy]]',
    });
    const report = await wiki.lint();
    const broken = report.checks.filter((c) => c.check === 'broken_links');
    expect(broken.length).to.be.greaterThan(0);
    expect(report.ok).to.equal(false);
  });
});

describe('LlmWiki.buildGraph', () => {
  it('returns empty nodes and edges for a wiki with no pages', async () => {
    const wiki = await newWiki();
    const graph = await wiki.buildGraph();
    expect(graph.nodes).to.have.length(0);
    expect(graph.edges).to.have.length(0);
  });

  it('produces one node and no edges for a page with no outbound links', async () => {
    const wiki = await newWiki();
    await wiki.commitPage({
      type: 'entity',
      title: 'Alpha',
      tags: ['host'],
      sources: [],
      body: 'No links here.',
    });
    const graph = await wiki.buildGraph();
    expect(graph.nodes).to.have.length(1);
    expect(graph.nodes[0].id).to.equal('entities/alpha');
    expect(graph.nodes[0].title).to.equal('Alpha');
    expect(graph.nodes[0].type).to.equal('entity');
    expect(graph.edges).to.have.length(0);
  });

  it('emits references edges for [[wikilinks]] in page body', async () => {
    const wiki = await newWiki();
    await wiki.commitPage({
      type: 'entity',
      title: 'A',
      tags: ['host'],
      sources: [],
      body: '[[b]] and [[c]]',
    });
    await wiki.commitPage({
      type: 'entity',
      title: 'B',
      tags: ['host'],
      sources: [],
      body: '[[a]] and [[c]]',
    });
    const graph = await wiki.buildGraph();
    expect(graph.nodes).to.have.length(2);
    const refs = graph.edges.filter((e) => e.type === 'references');
    expect(refs.some((e) => e.source === 'entities/a' && e.target === 'entities/b')).to.equal(true);
    expect(refs.some((e) => e.source === 'entities/b' && e.target === 'entities/a')).to.equal(true);
  });

  it('does not emit edges for unresolvable wikilinks', async () => {
    const wiki = await newWiki();
    await wiki.commitPage({
      type: 'entity',
      title: 'A',
      tags: ['host'],
      sources: [],
      body: 'See [[does-not-exist]]',
    });
    const graph = await wiki.buildGraph();
    expect(graph.edges).to.have.length(0);
  });

  it('deduplicates references edges when the same link appears multiple times', async () => {
    const wiki = await newWiki();
    await wiki.commitPage({
      type: 'entity',
      title: 'A',
      tags: ['host'],
      sources: [],
      body: '[[b]] and [[b]] again',
    });
    await wiki.commitPage({
      type: 'entity',
      title: 'B',
      tags: ['host'],
      sources: [],
      body: '[[a]] [[c]]',
    });
    const graph = await wiki.buildGraph();
    const aToB = graph.edges.filter((e) => e.source === 'entities/a' && e.target === 'entities/b');
    expect(aToB).to.have.length(1);
  });

  it('emits contradicts edges from the contradictions frontmatter field', async () => {
    const wiki = await newWiki();
    await wiki.commitPage({
      type: 'concept',
      title: 'A',
      tags: ['host'],
      sources: [],
      body: '[[b]] [[c]]',
      contradictions: ['entities/b'],
    });
    await wiki.commitPage({
      type: 'entity',
      title: 'B',
      tags: ['host'],
      sources: [],
      body: '[[a]] [[c]]',
    });
    const graph = await wiki.buildGraph();
    const contradicts = graph.edges.filter((e) => e.type === 'contradicts');
    expect(
      contradicts.some((e) => e.source === 'concepts/a' && e.target === 'entities/b'),
    ).to.equal(true);
  });

  it('resolves contradiction slugs by basename as well as full stem', async () => {
    const wiki = await newWiki();
    await wiki.commitPage({
      type: 'concept',
      title: 'A',
      tags: ['host'],
      sources: [],
      body: '[[b]] [[c]]',
      contradictions: ['b'],
    });
    await wiki.commitPage({
      type: 'entity',
      title: 'B',
      tags: ['host'],
      sources: [],
      body: '[[a]] [[c]]',
    });
    const graph = await wiki.buildGraph();
    const contradicts = graph.edges.filter((e) => e.type === 'contradicts');
    expect(
      contradicts.some((e) => e.source === 'concepts/a' && e.target === 'entities/b'),
    ).to.equal(true);
  });

  it('skips contradictions that do not match any known page', async () => {
    const wiki = await newWiki();
    await wiki.commitPage({
      type: 'entity',
      title: 'A',
      tags: ['host'],
      sources: [],
      body: '[[b]] [[c]]',
      contradictions: ['nonexistent-page'],
    });
    const graph = await wiki.buildGraph();
    expect(graph.edges.filter((e) => e.type === 'contradicts')).to.have.length(0);
  });

  it('does not include source nodes or derived_from edges by default', async () => {
    const wiki = await newWiki();
    await wiki.commitPage({
      type: 'entity',
      title: 'A',
      tags: ['host'],
      sources: ['raw/articles/x.md'],
      body: '[[b]] [[c]]',
    });
    const graph = await wiki.buildGraph();
    expect(graph.nodes.some((n) => n.type === 'source')).to.equal(false);
    expect(graph.edges.filter((e) => e.type === 'derived_from')).to.have.length(0);
  });

  it('adds source nodes and derived_from edges when includeSources is true', async () => {
    const wiki = await newWiki();
    await wiki.commitPage({
      type: 'entity',
      title: 'A',
      tags: ['host'],
      sources: ['raw/articles/x.md'],
      body: '[[b]] [[c]]',
    });
    const graph = await wiki.buildGraph({ includeSources: true });
    expect(graph.nodes.some((n) => n.id === 'raw/articles/x' && n.type === 'source')).to.equal(
      true,
    );
    expect(
      graph.edges.some(
        (e) =>
          e.source === 'entities/a' && e.target === 'raw/articles/x' && e.type === 'derived_from',
      ),
    ).to.equal(true);
  });

  it('emits one source node but separate derived_from edges when multiple pages share a source', async () => {
    const wiki = await newWiki();
    await wiki.commitPage({
      type: 'entity',
      title: 'A',
      tags: ['host'],
      sources: ['raw/articles/shared.md'],
      body: '[[b]] [[c]]',
    });
    await wiki.commitPage({
      type: 'entity',
      title: 'B',
      tags: ['host'],
      sources: ['raw/articles/shared.md'],
      body: '[[a]] [[c]]',
    });
    const graph = await wiki.buildGraph({ includeSources: true });
    const sourceNodes = graph.nodes.filter((n) => n.id === 'raw/articles/shared');
    expect(sourceNodes).to.have.length(1);
    const derivedEdges = graph.edges.filter((e) => e.type === 'derived_from');
    expect(derivedEdges).to.have.length(2);
  });

  it('copies confidence and contested onto nodes when present', async () => {
    const wiki = await newWiki();
    await wiki.commitPage({
      type: 'entity',
      title: 'A',
      tags: ['host'],
      sources: [],
      body: '[[b]] [[c]]',
      confidence: 'low',
      contested: true,
    });
    const graph = await wiki.buildGraph();
    const node = graph.nodes.find((n) => n.id === 'entities/a');
    expect(node?.confidence).to.equal('low');
    expect(node?.contested).to.equal(true);
  });

  it('omits confidence and contested from nodes that lack those frontmatter fields', async () => {
    const wiki = await newWiki();
    await wiki.commitPage({
      type: 'entity',
      title: 'A',
      tags: ['host'],
      sources: [],
      body: '[[b]] [[c]]',
    });
    const graph = await wiki.buildGraph();
    const node = graph.nodes.find((n) => n.id === 'entities/a');
    expect(node?.confidence).to.equal(undefined);
    expect(node?.contested).to.equal(undefined);
  });
});
