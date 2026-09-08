import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createWikiRegistry, type WikiRegistry } from '@tkottke90/llm-wiki';
import { buildMergedGraph } from './wiki.route.js';

describe('routes/v1/wiki.route buildMergedGraph', () => {
  let dir: string;
  let registry: WikiRegistry;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wiki-route-test-'));
    registry = await createWikiRegistry({ wikiRoot: join(dir, 'wikiroot') });
    await registry.create({ id: 'homelab', domain: 'infrastructure' });
    await registry.create({ id: 'other-wiki', domain: 'other' });

    const homelab = await registry.load('homelab');
    await homelab.commitPage({
      type: 'entity',
      title: 'A',
      tags: [],
      sources: [],
      body: 'Local link [[b]] and cross-wiki [[other-wiki:entities/target]]',
    });
    await homelab.commitPage({
      type: 'entity',
      title: 'B',
      tags: [],
      sources: [],
      body: 'no links',
    });

    const other = await registry.load('other-wiki');
    await other.commitPage({
      type: 'entity',
      title: 'Target',
      tags: [],
      sources: [],
      body: 'no links',
    });
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('includes a cross-wiki edge connecting nodes in different domains', async () => {
    const graph = await buildMergedGraph(registry);
    const crossEdge = graph.edges.find(
      (e) => e.source === 'homelab:entities/a' && e.target === 'other-wiki:entities/target',
    );
    expect(crossEdge).to.not.equal(undefined);
    expect(crossEdge?.type).to.equal('references');
  });

  it('still includes intra-wiki edges and excludes metadata-type nodes', async () => {
    const graph = await buildMergedGraph(registry);
    expect(
      graph.edges.some(
        (e) => e.source === 'homelab:entities/a' && e.target === 'homelab:entities/b',
      ),
    ).to.equal(true);
    expect(graph.nodes.some((n) => n.type === 'index' || n.type === 'log')).to.equal(false);
  });

  it('tags every node with its owning domainId', async () => {
    const graph = await buildMergedGraph(registry);
    const targetNode = graph.nodes.find((n) => n.id === 'other-wiki:entities/target');
    expect(targetNode?.domainId).to.equal('other-wiki');
  });

  it('skips a domain that fails to load without failing the whole merge', async () => {
    const brokenRegistry = {
      list: () => [
        {
          id: 'homelab',
          path: 'homelab',
          domain: 'infrastructure',
          tags: [],
          status: 'active' as const,
        },
        { id: 'missing', path: 'missing', domain: 'x', tags: [], status: 'active' as const },
      ],
      load: (id: string) => {
        if (id === 'missing') return Promise.reject(new Error('boom'));
        return registry.load(id);
      },
    } as unknown as WikiRegistry;

    const graph = await buildMergedGraph(brokenRegistry);
    expect(graph.nodes.some((n) => n.domainId === 'homelab')).to.equal(true);
    expect(graph.nodes.some((n) => n.domainId === 'missing')).to.equal(false);
  });
});
