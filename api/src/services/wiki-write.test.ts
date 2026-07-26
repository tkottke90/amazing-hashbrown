import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createWikiRegistry, type WikiRegistry } from '@tkottke90/llm-wiki';
import { createWikiPage, updateWikiPage } from './wiki-write.js';

describe('services/wiki-write', () => {
  let dir: string;
  let registry: WikiRegistry;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wiki-write-test-'));
    registry = await createWikiRegistry({ wikiRoot: join(dir, 'wikiroot') });
    await registry.create({ id: 'test-wiki', domain: 'testing', tags: ['test'] });
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('createWikiPage()', () => {
    it('writes a new page', async () => {
      const result = await createWikiPage(
        {
          wikiId: 'test-wiki',
          title: 'Router',
          content: 'A router at home. See [[dns]] and [[proxy]].',
          section: 'entity',
          tags: ['router'],
        },
        registry,
      );
      expect(result.status).to.equal('written');
      if (result.status !== 'written') return;
      expect(result.result.created).to.equal(true);
      expect(result.result.path).to.equal('entities/router.md');

      const wiki = await registry.load('test-wiki');
      const page = await wiki.readPage('entities/router.md');
      expect(page.content).to.contain('A router at home.');
    });

    it('returns duplicate without writing when a matching page already exists', async () => {
      await createWikiPage(
        {
          wikiId: 'test-wiki',
          title: 'Proxy Notes',
          content: 'The proxy service handles traffic routing. See [[dns]] and [[host]].',
          section: 'entity',
          tags: ['proxy'],
        },
        registry,
      );

      const second = await createWikiPage(
        {
          wikiId: 'test-wiki',
          title: 'Proxy Details',
          content: 'More about the proxy configuration.',
          section: 'entity',
          tags: ['proxy'],
        },
        registry,
      );

      expect(second.status).to.equal('duplicate');
      if (second.status !== 'duplicate') return;
      expect(second.existingPath).to.equal('entities/proxy-notes.md');
    });

    it('dry-run does not write and reports title/wikiId/section, not a path', async () => {
      const result = await createWikiPage(
        {
          wikiId: 'test-wiki',
          title: 'DryRun Entity',
          content: 'Some unique content about a widget.',
          section: 'concept',
          tags: ['widget'],
          dryRun: true,
        },
        registry,
      );
      expect(result).to.deep.equal({
        status: 'dry_run',
        title: 'DryRun Entity',
        wikiId: 'test-wiki',
        section: 'concept',
      });

      const wiki = await registry.load('test-wiki');
      let threw = false;
      try {
        await wiki.readPage('concepts/dryrun-entity.md');
      } catch {
        threw = true;
      }
      expect(threw, 'dry run must not write a file').to.equal(true);
    });

    it('returns unknown_wiki for an unregistered wikiId', async () => {
      const result = await createWikiPage(
        { wikiId: 'does-not-exist', title: 'X', content: 'x', section: 'entity' },
        registry,
      );
      expect(result).to.deep.equal({ status: 'unknown_wiki', wikiId: 'does-not-exist' });
    });
  });

  describe('updateWikiPage()', () => {
    it('updates an existing page', async () => {
      const created = await createWikiPage(
        {
          wikiId: 'test-wiki',
          title: 'Host',
          content: 'v1. See [[dns]] and [[proxy]].',
          section: 'entity',
          tags: ['host'],
        },
        registry,
      );
      expect(created.status).to.equal('written');
      if (created.status !== 'written') return;

      const updated = await updateWikiPage(
        {
          wikiId: 'test-wiki',
          path: created.result.path,
          content: 'v2. See [[dns]] and [[proxy]].',
        },
        registry,
      );
      expect(updated.status).to.equal('written');
      if (updated.status !== 'written') return;
      expect(updated.result.created).to.equal(false);

      const wiki = await registry.load('test-wiki');
      const page = await wiki.readPage(created.result.path);
      expect(page.content).to.contain('v2.');
    });

    it('carries forward tags and sources when omitted', async () => {
      const created = await createWikiPage(
        {
          wikiId: 'test-wiki',
          title: 'Carry Forward',
          content: 'Original body. See [[dns]] and [[proxy]].',
          section: 'entity',
          tags: ['alpha', 'beta'],
          sources: ['raw/original.md'],
        },
        registry,
      );
      expect(created.status).to.equal('written');
      if (created.status !== 'written') return;

      await updateWikiPage(
        {
          wikiId: 'test-wiki',
          path: created.result.path,
          content: 'Updated body. See [[dns]] and [[proxy]].',
          // tags/sources omitted deliberately
        },
        registry,
      );

      const wiki = await registry.load('test-wiki');
      const page = await wiki.readPage(created.result.path);
      expect(page.frontmatter.tags).to.have.members(['alpha', 'beta']);
      expect(page.frontmatter.sources).to.include('raw/original.md');
    });

    it('returns not_found for a nonexistent path', async () => {
      const result = await updateWikiPage(
        { wikiId: 'test-wiki', path: 'entities/does-not-exist.md', content: 'x' },
        registry,
      );
      expect(result).to.deep.equal({ status: 'not_found' });
    });

    it('returns invalid_path for a traversal attempt', async () => {
      const result = await updateWikiPage(
        { wikiId: 'test-wiki', path: '../../../etc/passwd', content: 'x' },
        registry,
      );
      expect(result).to.deep.equal({ status: 'invalid_path' });
    });

    it('dry-run returns both bodies and does not write', async () => {
      const created = await createWikiPage(
        {
          wikiId: 'test-wiki',
          title: 'Diff Target',
          content: 'line one\nline two',
          section: 'entity',
          tags: ['difftarget'],
        },
        registry,
      );
      expect(created.status).to.equal('written');
      if (created.status !== 'written') return;

      const dry = await updateWikiPage(
        {
          wikiId: 'test-wiki',
          path: created.result.path,
          content: 'line one\nline TWO changed',
          dryRun: true,
        },
        registry,
      );
      expect(dry.status).to.equal('dry_run');
      if (dry.status !== 'dry_run') return;
      expect(dry.existingBody).to.contain('line two');
      expect(dry.proposedBody).to.contain('line TWO changed');

      const wiki = await registry.load('test-wiki');
      const page = await wiki.readPage(created.result.path);
      expect(page.content).to.contain('line two'); // unchanged on disk
    });

    it('returns unknown_wiki for an unregistered wikiId', async () => {
      const result = await updateWikiPage(
        { wikiId: 'does-not-exist', path: 'entities/x.md', content: 'x' },
        registry,
      );
      expect(result).to.deep.equal({ status: 'unknown_wiki', wikiId: 'does-not-exist' });
    });
  });
});
