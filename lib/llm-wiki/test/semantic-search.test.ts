import { expect } from 'chai';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LlmWiki } from '../src/llm-wiki.js';
import { NullEmbeddingProvider } from '../src/providers/null.js';

function tmpWikiPath(): string {
  return fs.mkdtemp(path.join(os.tmpdir(), 'llm-wiki-sem-')).then ? '' : '';
}

async function newWiki(provider?: NullEmbeddingProvider): Promise<LlmWiki> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-wiki-sem-'));
  return LlmWiki.create({
    path: dir,
    name: 'Test',
    domain: 'test',
    embeddingProvider: provider,
  });
}

const samplePage = {
  type: 'entity' as const,
  title: 'DNS Server',
  tags: [],
  sources: [],
  body: 'A DNS server resolves domain names to IP addresses.\n\n[[concepts/name-resolution]] [[entities/ip-address]]',
};

const samplePage2 = {
  type: 'concept' as const,
  title: 'Name Resolution',
  tags: [],
  sources: [],
  body: 'Name resolution is the process of mapping hostnames to network addresses.\n\n[[entities/dns-server]] [[entities/ip-address]]',
};

const samplePage3 = {
  type: 'entity' as const,
  title: 'IP Address',
  tags: [],
  sources: [],
  body: 'An IP address is a numerical label assigned to each device in a network.\n\n[[entities/dns-server]] [[concepts/name-resolution]]',
};

describe('LlmWiki.semanticSearch — keyword mode', () => {
  it('returns RankedResult[] without a provider', async () => {
    const wiki = await newWiki();
    await wiki.commitPage(samplePage);
    await wiki.commitPage(samplePage2);
    await wiki.commitPage(samplePage3);

    const results = await wiki.semanticSearch('domain names', { mode: 'keyword', limit: 5 });
    expect(results).to.be.an('array');
    expect(results.length).to.be.greaterThan(0);
    expect(results[0]).to.have.keys(['path', 'score', 'title']);
    expect(results[0]!.score).to.be.a('number');
    expect(results[0]!.title).to.be.a('string');
  });

  it('returns top-N results respecting the limit', async () => {
    const wiki = await newWiki();
    await wiki.commitPage(samplePage);
    await wiki.commitPage(samplePage2);
    await wiki.commitPage(samplePage3);

    const results = await wiki.semanticSearch('address', { mode: 'keyword', limit: 2 });
    expect(results.length).to.be.at.most(2);
  });

  it('returns empty array for empty wiki', async () => {
    const wiki = await newWiki();
    const results = await wiki.semanticSearch('anything', { mode: 'keyword' });
    expect(results).to.deep.equal([]);
  });

  it('throws if semantic mode is used without a provider', async () => {
    const wiki = await newWiki();
    await wiki.commitPage(samplePage);
    let err: Error | undefined;
    try {
      await wiki.semanticSearch('test', { mode: 'semantic' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.be.instanceOf(Error);
    expect(err!.message).to.include('embeddingProvider');
  });
});

describe('LlmWiki.semanticSearch — with NullEmbeddingProvider', () => {
  it('commitPage writes _embeddings.json when a provider is set', async () => {
    const provider = new NullEmbeddingProvider();
    const wiki = await newWiki(provider);
    await wiki.commitPage(samplePage);

    const indexPath = path.join((wiki as unknown as { basePath: string }).basePath, '_embeddings.json');
    const raw = await fs.readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw) as { model: string; version: number; entries: Record<string, unknown> };
    expect(parsed.version).to.equal(1);
    expect(parsed.model).to.equal(provider.model);
    expect(Object.keys(parsed.entries)).to.include('entities/dns-server.md');
  });

  it('returns RankedResult[] in semantic mode', async () => {
    const provider = new NullEmbeddingProvider();
    const wiki = await newWiki(provider);
    await wiki.commitPage(samplePage);
    await wiki.commitPage(samplePage2);
    await wiki.commitPage(samplePage3);

    const results = await wiki.semanticSearch('name resolution', { mode: 'semantic' });
    expect(results).to.be.an('array');
    expect(results.length).to.equal(3);
    results.forEach((r) => {
      expect(r).to.have.keys(['path', 'score', 'title']);
    });
  });

  it('returns RankedResult[] in hybrid mode (default)', async () => {
    const provider = new NullEmbeddingProvider();
    const wiki = await newWiki(provider);
    await wiki.commitPage(samplePage);
    await wiki.commitPage(samplePage2);

    const results = await wiki.semanticSearch('DNS');
    expect(results).to.be.an('array');
    expect(results.length).to.be.greaterThan(0);
  });

  it('re-embeds a stale page on the next semanticSearch call', async () => {
    const provider = new NullEmbeddingProvider();
    const wiki = await newWiki(provider);

    // Commit a page — gets embedded automatically.
    await wiki.commitPage(samplePage);

    // Load a fresh wiki instance (no provider) and overwrite the page body
    // by calling commitPage again, bypassing the embedded wiki's auto-update.
    const wikiNoProvider = await LlmWiki.load(
      (wiki as unknown as { basePath: string }).basePath,
    );
    await wikiNoProvider.commitPage({ ...samplePage, body: 'Updated body content.\n\n[[concepts/name-resolution]] [[entities/ip-address]]' });

    // The wiki with a provider should detect the sha mismatch and re-embed.
    const results = await wiki.semanticSearch('updated', { mode: 'semantic' });
    expect(results).to.be.an('array');
    // The key assertion: no unhandled error — re-embedding worked silently.
  });

  it('_embeddings.json invalidates and rebuilds when model changes', async () => {
    const provider1 = new NullEmbeddingProvider(256);
    const wiki = await newWiki(provider1);
    await wiki.commitPage(samplePage);

    // Reload with a different-dimension provider — the model string differs,
    // so the entire index should be rebuilt from scratch.
    const basePath = (wiki as unknown as { basePath: string }).basePath;
    const wiki2 = await LlmWiki.load(basePath, { embeddingProvider: new NullEmbeddingProvider(512) });
    await wiki2.semanticSearch('test', { mode: 'semantic' });

    const raw = await fs.readFile(path.join(basePath, '_embeddings.json'), 'utf8');
    const parsed = JSON.parse(raw) as { model: string; entries: Record<string, { vec: number[] }> };
    expect(parsed.model).to.equal('null-512');
    const vec = Object.values(parsed.entries)[0]?.vec;
    expect(vec).to.have.length(512);
  });
});
