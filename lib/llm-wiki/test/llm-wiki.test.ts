import { expect } from 'chai';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EmbeddingAdapter } from '@tkottke90/inference-adapter';
import { LlmWiki, createWikiRegistry } from '../src/index.js';

async function tmpWikiPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-wiki-'));
  return path.join(dir, 'wiki');
}

async function newWiki(opts: { embeddingProvider?: EmbeddingAdapter } = {}): Promise<LlmWiki> {
  return LlmWiki.create({
    path: await tmpWikiPath(),
    name: 'homelab',
    domain: 'infrastructure and services',
    tags: ['host', 'service', 'dns'],
    embeddingProvider: opts.embeddingProvider,
  });
}

/** Deterministic fake embedding adapter for duplicate-detection tests:
 *  callers assign known vectors to known texts via `vectorFor`, so cosine
 *  similarity between any two embedded texts is fully controllable. Tracks
 *  every text it was asked to embed, so tests can assert a candidate's body
 *  was never embedded (proving stage 2 wasn't reached). */
function makeFakeEmbeddingAdapter(vectorFor: (text: string) => number[]): EmbeddingAdapter & {
  embedded: string[];
} {
  const embedded: string[] = [];
  return {
    model: 'fake-test-model',
    embedded,
    async embed(texts: string[]): Promise<number[][]> {
      embedded.push(...texts);
      return texts.map(vectorFor);
    },
  };
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

describe('LlmWiki duplicate detection (findSimilarPages)', () => {
  // "Jellyfin Media Server" (existing) vs. "Jellyfin Media Setup" (proposed):
  // 2 of 3 significant title words overlap (jellyfin, media), meeting the
  // >=60% shortlist threshold (ceil(3 * 0.6) = 2) without being an exact
  // title match — this is the "shortlisted but needs content confirmation"
  // shape every case below reuses.
  async function wikiWithMediaServerPage(opts: { embeddingProvider?: EmbeddingAdapter } = {}) {
    const wiki = await newWiki(opts);
    await wiki.commitPage({
      type: 'entity',
      title: 'Jellyfin Media Server',
      tags: ['service'],
      sources: [],
      body: 'Runs on the Unraid NAS and streams video to clients.',
    });
    return wiki;
  }

  it('no provider: rejects a proposed title with no real title overlap (Jellyfin/Authentik repro) [unit]', async () => {
    const wiki = await newWiki();
    await wiki.commitPage({
      type: 'entity',
      title: 'Authentik',
      tags: ['service'],
      sources: [],
      body: 'Authentik provides SSO for homelab services. Jellyfin and other apps authenticate through Authentik.',
    });
    const prep = await wiki.ingestPrep({
      content: 'Jellyfin is the homelab media server.',
      title: 'Jellyfin',
    });
    expect(prep.existingPages).to.deep.equal([]);
  });

  it('no provider: shortlists but does not confirm a title-similar page with low body overlap (bridge page) [unit]', async () => {
    const wiki = await wikiWithMediaServerPage();
    const prep = await wiki.ingestPrep({
      content:
        'Installation steps for configuring hardware transcoding with dedicated GPU passthrough ' +
        'drivers and firmware updates.',
      title: 'Jellyfin Media Setup',
    });
    expect(prep.existingPages).to.deep.equal([]);
  });

  it('no provider: confirms a title-similar page whose body substantially overlaps [unit]', async () => {
    const wiki = await wikiWithMediaServerPage();
    const prep = await wiki.ingestPrep({
      content: 'Runs on the Unraid NAS and streams video to clients. Same setup, same network.',
      title: 'Jellyfin Media Setup',
    });
    expect(prep.existingPages).to.include('entities/jellyfin-media-server.md');
  });

  it('provider configured: excludes an unrelated title before ever calling embed (Jellyfin/Authentik repro) [unit]', async () => {
    const fakeAdapter = makeFakeEmbeddingAdapter(() => [1]);
    const wiki = await newWiki({ embeddingProvider: fakeAdapter });
    await wiki.commitPage({
      type: 'entity',
      title: 'Authentik',
      tags: ['service'],
      sources: [],
      body: 'Authentik provides SSO for homelab services. Jellyfin and other apps authenticate through Authentik.',
    });
    // commitPage() itself eagerly embeds the new page for the semantic-search
    // index (see "commitPage writes _embeddings.json when a provider is set",
    // above) — that one call is unrelated to duplicate detection, so only
    // calls made *during* ingestPrep below count as evidence stage 2 ran.
    const embedCallsBeforeIngest = fakeAdapter.embedded.length;
    const prep = await wiki.ingestPrep({
      content: 'Jellyfin is the homelab media server.',
      title: 'Jellyfin',
    });
    expect(prep.existingPages).to.deep.equal([]);
    expect(
      fakeAdapter.embedded.length,
      'stage 2 must never run when stage 1 shortlists nothing',
    ).to.equal(embedCallsBeforeIngest);
  });

  it('provider configured: shortlists but does not confirm a title-similar page with dissimilar body embeddings (bridge page) [unit]', async () => {
    const vectorFor = (text: string): number[] =>
      text.includes('ALPHA_MARKER') ? [1, 0] : text.includes('BETA_MARKER') ? [0, 1] : [0, 0];
    const fakeAdapter = makeFakeEmbeddingAdapter(vectorFor);
    const wiki = await newWiki({ embeddingProvider: fakeAdapter });
    await wiki.commitPage({
      type: 'entity',
      title: 'Jellyfin Media Server',
      tags: ['service'],
      sources: [],
      body: 'ALPHA_MARKER_CONTENT describing the media server.',
    });
    const prep = await wiki.ingestPrep({
      content: 'BETA_MARKER_CONTENT describing something unrelated.',
      title: 'Jellyfin Media Setup',
    });
    expect(prep.existingPages).to.deep.equal([]);
    expect(
      fakeAdapter.embedded.length,
      'stage 2 should have run (unlike the repro case)',
    ).to.be.greaterThan(0);
  });

  it('provider configured: confirms a title-similar page with near-identical body embeddings [unit]', async () => {
    const vectorFor = (text: string): number[] => (text.includes('ALPHA_MARKER') ? [1, 0] : [0, 1]);
    const fakeAdapter = makeFakeEmbeddingAdapter(vectorFor);
    const wiki = await newWiki({ embeddingProvider: fakeAdapter });
    await wiki.commitPage({
      type: 'entity',
      title: 'Jellyfin Media Server',
      tags: ['service'],
      sources: [],
      body: 'ALPHA_MARKER_CONTENT describing the media server.',
    });
    const prep = await wiki.ingestPrep({
      content: 'ALPHA_MARKER_CONTENT describing the exact same media server.',
      title: 'Jellyfin Media Setup',
    });
    expect(prep.existingPages).to.include('entities/jellyfin-media-server.md');
  });

  it('provider configured: falls back to lexical overlap without throwing when embed() rejects [unit]', async () => {
    const failingAdapter: EmbeddingAdapter = {
      model: 'failing-test-model',
      async embed(): Promise<number[][]> {
        throw new Error('simulated embedding provider outage');
      },
    };
    const wiki = await wikiWithMediaServerPage({ embeddingProvider: failingAdapter });
    const prep = await wiki.ingestPrep({
      content: 'Runs on the Unraid NAS and streams video to clients. Same setup, same network.',
      title: 'Jellyfin Media Setup',
    });
    expect(prep.existingPages).to.include('entities/jellyfin-media-server.md');
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
    expect(graph.nodes[0].id).to.equal('wiki:entities/alpha');
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
    expect(
      refs.some((e) => e.source === 'wiki:entities/a' && e.target === 'wiki:entities/b'),
    ).to.equal(true);
    expect(
      refs.some((e) => e.source === 'wiki:entities/b' && e.target === 'wiki:entities/a'),
    ).to.equal(true);
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
    const aToB = graph.edges.filter(
      (e) => e.source === 'wiki:entities/a' && e.target === 'wiki:entities/b',
    );
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
      contradicts.some((e) => e.source === 'wiki:concepts/a' && e.target === 'wiki:entities/b'),
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
      contradicts.some((e) => e.source === 'wiki:concepts/a' && e.target === 'wiki:entities/b'),
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
    expect(graph.nodes.some((n) => n.id === 'wiki:raw/articles/x' && n.type === 'source')).to.equal(
      true,
    );
    expect(
      graph.edges.some(
        (e) =>
          e.source === 'wiki:entities/a' &&
          e.target === 'wiki:raw/articles/x' &&
          e.type === 'derived_from',
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
    const sourceNodes = graph.nodes.filter((n) => n.id === 'wiki:raw/articles/shared');
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
    const node = graph.nodes.find((n) => n.id === 'wiki:entities/a');
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
    const node = graph.nodes.find((n) => n.id === 'wiki:entities/a');
    expect(node?.confidence).to.equal(undefined);
    expect(node?.contested).to.equal(undefined);
  });
});

describe('LlmWiki.buildGraph cross-wiki references', () => {
  async function tmpRegistryRoot(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'wiki-root-'));
  }

  it('leaves an external reference unresolved when no registry is supplied', async () => {
    const wiki = await newWiki();
    await wiki.commitPage({
      type: 'entity',
      title: 'A',
      tags: ['host'],
      sources: [],
      body: 'See [[other-wiki:entities/target]]',
    });
    const graph = await wiki.buildGraph();
    expect(graph.edges).to.have.length(0);
  });

  it('resolves a cross-wiki wikilink into a namespaced references edge when a registry is supplied', async () => {
    const registry = await createWikiRegistry({ wikiRoot: await tmpRegistryRoot() });
    const source = await registry.create({ id: 'source-wiki', domain: 'x' });
    const target = await registry.create({ id: 'other-wiki', domain: 'y' });
    await target.commitPage({
      type: 'entity',
      title: 'Target',
      tags: [],
      sources: [],
      body: 'no links',
    });
    await source.commitPage({
      type: 'entity',
      title: 'A',
      tags: [],
      sources: [],
      body: 'See [[other-wiki:entities/target]]',
    });
    const graph = await source.buildGraph({ registry });
    expect(
      graph.edges.some(
        (e) =>
          e.source === 'source-wiki:entities/a' &&
          e.target === 'other-wiki:entities/target' &&
          e.type === 'references',
      ),
    ).to.equal(true);
  });

  it('does not emit an edge when the referenced wiki does not exist', async () => {
    const registry = await createWikiRegistry({ wikiRoot: await tmpRegistryRoot() });
    const source = await registry.create({ id: 'source-wiki', domain: 'x' });
    await source.commitPage({
      type: 'entity',
      title: 'A',
      tags: [],
      sources: [],
      body: 'See [[nonexistent-wiki:entities/target]]',
    });
    const graph = await source.buildGraph({ registry });
    expect(graph.edges).to.have.length(0);
  });

  it('does not emit an edge when the referenced page does not exist in the target wiki', async () => {
    const registry = await createWikiRegistry({ wikiRoot: await tmpRegistryRoot() });
    const source = await registry.create({ id: 'source-wiki', domain: 'x' });
    await registry.create({ id: 'other-wiki', domain: 'y' });
    await source.commitPage({
      type: 'entity',
      title: 'A',
      tags: [],
      sources: [],
      body: 'See [[other-wiki:entities/nonexistent]]',
    });
    const graph = await source.buildGraph({ registry });
    expect(graph.edges).to.have.length(0);
  });

  it('resolves a cross-wiki contradictions entry into a namespaced contradicts edge', async () => {
    const registry = await createWikiRegistry({ wikiRoot: await tmpRegistryRoot() });
    const source = await registry.create({ id: 'source-wiki', domain: 'x' });
    const target = await registry.create({ id: 'other-wiki', domain: 'y' });
    await target.commitPage({
      type: 'entity',
      title: 'Target',
      tags: [],
      sources: [],
      body: 'no links',
    });
    await source.commitPage({
      type: 'concept',
      title: 'A',
      tags: [],
      sources: [],
      body: 'no links',
      contradictions: ['other-wiki:entities/target'],
    });
    const graph = await source.buildGraph({ registry });
    expect(
      graph.edges.some(
        (e) =>
          e.source === 'source-wiki:concepts/a' &&
          e.target === 'other-wiki:entities/target' &&
          e.type === 'contradicts',
      ),
    ).to.equal(true);
  });
});

/** Awaits `p`, returning its rejection message. Fails the test if `p` resolves. */
async function rejectionMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected promise to reject, but it resolved');
}

describe('LlmWiki.archive', () => {
  it('sets index.md frontmatter status to archived, preserving the rest', async () => {
    const wiki = await newWiki();
    await wiki.archive();
    const { index } = await wiki.orient();
    expect(index).to.match(/status:\s*archived/);
    expect(index).to.contain('# Wiki Index');
  });

  it('is idempotent — calling archive() twice does not throw', async () => {
    const wiki = await newWiki();
    await wiki.archive();
    await wiki.archive();
    const { index } = await wiki.orient();
    expect(index).to.match(/status:\s*archived/);
  });

  it('rejects commitPage once archived', async () => {
    const wiki = await newWiki();
    await wiki.archive();
    const message = await rejectionMessage(
      wiki.commitPage({ type: 'entity', title: 'A', tags: [], sources: [], body: 'body' }),
    );
    expect(message).to.contain('archived');
  });

  it('rejects addCrossLink once archived', async () => {
    const wiki = await newWiki();
    await wiki.commitPage({ type: 'entity', title: 'A', tags: [], sources: [], body: 'body' });
    await wiki.commitPage({ type: 'entity', title: 'B', tags: [], sources: [], body: 'body' });
    await wiki.archive();
    const message = await rejectionMessage(
      wiki.addCrossLink({ fromPage: 'entities/a.md', toPage: 'entities/b.md' }),
    );
    expect(message).to.contain('archived');
  });

  it('rejects saveRawSource once archived', async () => {
    const wiki = await newWiki();
    await wiki.archive();
    const message = await rejectionMessage(
      wiki.saveRawSource({ path: 'raw/x.md', sourceUrl: '', sha256: 'abc', content: 'body' }),
    );
    expect(message).to.contain('archived');
  });

  it('rejects rebaselineRawSource once archived', async () => {
    const wiki = await newWiki();
    await wiki.saveRawSource({ path: 'raw/x.md', sourceUrl: '', sha256: 'abc', content: 'body' });
    await wiki.archive();
    const message = await rejectionMessage(wiki.rebaselineRawSource('raw/x.md'));
    expect(message).to.contain('archived');
  });

  it('still allows reads once archived', async () => {
    const wiki = await newWiki();
    await wiki.commitPage({ type: 'entity', title: 'A', tags: [], sources: [], body: 'body' });
    await wiki.archive();
    const pages = await wiki.listPages();
    expect(pages).to.have.length(1);
    const { schema } = await wiki.orient();
    expect(schema).to.contain('infrastructure and services');
  });
});
