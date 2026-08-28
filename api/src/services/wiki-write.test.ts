import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { createWikiRegistry, type WikiRegistry } from '@tkottke90/llm-wiki';
import { createWikiPage, updateWikiPage } from './wiki-write.js';
import { WorkspaceStore } from './workspace-store.js';

describe('services/wiki-write', () => {
  let dir: string;
  let registry: WikiRegistry;
  let store: WorkspaceStore;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wiki-write-test-'));
    registry = await createWikiRegistry({ wikiRoot: join(dir, 'wikiroot') });
    await registry.create({ id: 'test-wiki', domain: 'testing', tags: ['test'] });

    store = new WorkspaceStore(openDatabase(join(dir, 'test.db')));
    await registry.create({ id: 'archived-wiki', domain: 'archived', tags: [] });
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

  describe('createWikiPage()', () => {
    it('writes a new page', async () => {
      const result = await createWikiPage(
        {
          wikiId: 'test-wiki',
          title: 'Router',
          content: 'A router at home. See [[dns]] and [[network]].',
          section: 'entity',
          tags: ['router'],
        },
        registry,
        undefined,
        store,
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
          title: 'Proxy Service Notes',
          content: 'The proxy service handles traffic routing. See [[dns]] and [[gateway]].',
          section: 'entity',
          tags: ['proxy'],
        },
        registry,
        undefined,
        store,
      );

      // "Proxy Service Details" shares 2 of 3 significant words with "Proxy Service Notes"
      // (proxy, service), meeting the ≥60% threshold (ceil(1.8) = 2) — a clear duplicate.
      const second = await createWikiPage(
        {
          wikiId: 'test-wiki',
          title: 'Proxy Service Details',
          content: 'More about the proxy service configuration.',
          section: 'entity',
          tags: ['proxy'],
        },
        registry,
        undefined,
        store,
      );

      expect(second.status).to.equal('duplicate');
      if (second.status !== 'duplicate') return;
      expect(second.existingPath).to.equal('entities/proxy-service-notes.md');
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
        undefined,
        store,
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
        undefined,
        store,
      );
      expect(result).to.deep.equal({ status: 'unknown_wiki', wikiId: 'does-not-exist' });
    });

    it('returns unknown_wiki (not wiki_forbidden) for an unregistered wikiId even when allowedWikiId is set', async () => {
      const result = await createWikiPage(
        { wikiId: 'does-not-exist', title: 'X', content: 'x', section: 'entity' },
        registry,
        'test-wiki',
        store,
      );
      expect(result).to.deep.equal({ status: 'unknown_wiki', wikiId: 'does-not-exist' });
    });

    it('returns wiki_forbidden when wikiId does not match allowedWikiId', async () => {
      await registry.create({ id: 'other-wiki', domain: 'other', tags: [] });
      const result = await createWikiPage(
        {
          wikiId: 'other-wiki',
          title: 'Forbidden Page',
          content: 'Should not be written.',
          section: 'entity',
        },
        registry,
        'test-wiki',
        store,
      );
      expect(result).to.deep.equal({
        status: 'wiki_forbidden',
        wikiId: 'other-wiki',
        allowedWikiId: 'test-wiki',
      });

      const wiki = await registry.load('other-wiki');
      let threw = false;
      try {
        await wiki.readPage('entities/forbidden-page.md');
      } catch {
        threw = true;
      }
      expect(threw, 'a forbidden write must not create the page').to.equal(true);
    });

    it('writes normally when wikiId matches allowedWikiId', async () => {
      const result = await createWikiPage(
        {
          wikiId: 'test-wiki',
          title: 'Allowed Page',
          content: 'This is fine. See [[dns]] and [[network]].',
          section: 'entity',
        },
        registry,
        'test-wiki',
        store,
      );
      expect(result.status).to.equal('written');
    });

    it('returns wiki_archived and does not write when the target domain is archived', async () => {
      const result = await createWikiPage(
        {
          wikiId: 'archived-wiki',
          title: 'Too Late',
          content: 'Should not be written.',
          section: 'entity',
        },
        registry,
        undefined,
        store,
      );
      expect(result).to.deep.equal({ status: 'wiki_archived', wikiId: 'archived-wiki' });

      const wiki = await registry.load('archived-wiki');
      let threw = false;
      try {
        await wiki.readPage('entities/too-late.md');
      } catch {
        threw = true;
      }
      expect(threw, 'an archived-domain write must not create the page').to.equal(true);
    });
  });

  describe('updateWikiPage()', () => {
    it('updates an existing page', async () => {
      const created = await createWikiPage(
        {
          wikiId: 'test-wiki',
          title: 'Host',
          content: 'v1. See [[dns]] and [[network]].',
          section: 'entity',
          tags: ['host'],
        },
        registry,
        undefined,
        store,
      );
      expect(created.status).to.equal('written');
      if (created.status !== 'written') return;

      const updated = await updateWikiPage(
        {
          wikiId: 'test-wiki',
          path: created.result.path,
          content: 'v2. See [[dns]] and [[network]].',
        },
        registry,
        undefined,
        store,
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
          content: 'Original body. See [[dns]] and [[network]].',
          section: 'entity',
          tags: ['alpha', 'beta'],
          sources: ['raw/original.md'],
        },
        registry,
        undefined,
        store,
      );
      expect(created.status).to.equal('written');
      if (created.status !== 'written') return;

      await updateWikiPage(
        {
          wikiId: 'test-wiki',
          path: created.result.path,
          content: 'Updated body. See [[dns]] and [[network]].',
          // tags/sources omitted deliberately
        },
        registry,
        undefined,
        store,
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
        undefined,
        store,
      );
      expect(result).to.deep.equal({ status: 'not_found' });
    });

    it('returns invalid_path for a traversal attempt', async () => {
      const result = await updateWikiPage(
        { wikiId: 'test-wiki', path: '../../../etc/passwd', content: 'x' },
        registry,
        undefined,
        store,
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
        undefined,
        store,
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
        undefined,
        store,
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
        undefined,
        store,
      );
      expect(result).to.deep.equal({ status: 'unknown_wiki', wikiId: 'does-not-exist' });
    });

    it('returns wiki_forbidden when wikiId does not match allowedWikiId', async () => {
      const created = await createWikiPage(
        {
          wikiId: 'test-wiki',
          title: 'Thermostat Settings',
          content: 'v1. See [[dns]] and [[network]].',
          section: 'entity',
          tags: ['thermostat'],
        },
        registry,
        undefined,
        store,
      );
      expect(created.status).to.equal('written');
      if (created.status !== 'written') return;

      // Same page path, but requested against a wiki other than the
      // session's allowed one — the mismatch is caught before path/existence
      // is even considered.
      const result = await updateWikiPage(
        { wikiId: 'test-wiki', path: created.result.path, content: 'v2.' },
        registry,
        'some-other-allowed-wiki',
        store,
      );
      expect(result).to.deep.equal({
        status: 'wiki_forbidden',
        wikiId: 'test-wiki',
        allowedWikiId: 'some-other-allowed-wiki',
      });

      const wiki = await registry.load('test-wiki');
      const page = await wiki.readPage(created.result.path);
      expect(page.content).to.contain('v1.'); // unchanged
    });

    it('writes normally when wikiId matches allowedWikiId', async () => {
      const created = await createWikiPage(
        {
          wikiId: 'test-wiki',
          title: 'Recycling Pickup Schedule',
          content: 'v1. See [[dns]] and [[network]].',
          section: 'entity',
          tags: ['recycling'],
        },
        registry,
        undefined,
        store,
      );
      expect(created.status).to.equal('written');
      if (created.status !== 'written') return;

      const result = await updateWikiPage(
        { wikiId: 'test-wiki', path: created.result.path, content: 'v2.' },
        registry,
        'test-wiki',
        store,
      );
      expect(result.status).to.equal('written');
    });

    it('returns wiki_archived and does not write when the target domain is archived', async () => {
      const result = await updateWikiPage(
        { wikiId: 'archived-wiki', path: 'entities/anything.md', content: 'v2.' },
        registry,
        undefined,
        store,
      );
      expect(result).to.deep.equal({ status: 'wiki_archived', wikiId: 'archived-wiki' });
    });
  });
});
