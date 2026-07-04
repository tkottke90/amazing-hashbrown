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

  it('finds existing pages by keyword', async () => {
    const wiki = await newWiki();
    await wiki.commitPage({
      type: 'entity',
      title: 'DNS Server',
      tags: ['dns'],
      sources: [],
      body: 'Runs unbound. [[host]] [[proxy]]',
    });
    const prep = await wiki.ingestPrep({ content: 'about unbound', keywords: ['unbound'] });
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
