import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { createWikiRegistry, type WikiRegistry } from '@tkottke90/llm-wiki';
import { WorkspaceStore } from '../../services/workspace-store.js';
import { createProjectHandler, patchProjectHandler, slugify } from './projects.handlers.js';

describe('routes/v1/projects.handlers', () => {
  describe('createProjectHandler()', () => {
    let store: WorkspaceStore;
    let registry: WikiRegistry;
    let dir: string;
    let wikiRoot: string;
    let workspaceDirs: string[];

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'projects-handlers-test-'));
      wikiRoot = join(dir, 'wiki');
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
      registry = await createWikiRegistry({ wikiRoot });
      workspaceDirs = [];
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      for (const wsDir of workspaceDirs) rmSync(wsDir, { recursive: true, force: true });
    });

    it('creates an ephemeral wiki domain and stamps it on the workspace', async () => {
      const result = await createProjectHandler(
        store,
        {
          name: 'My Project',
          locationRoot: 'temporary',
          directoryName: `wiki-test-${randomUUID()}`,
          winCondition: 'It ships',
        },
        registry,
      );

      expect(result.ok, `expected success, got: ${JSON.stringify(result)}`).to.equal(true);
      if (!result.ok) return;
      workspaceDirs.push(result.data.workspace.location);

      const { workspace } = result.data;
      expect(workspace.wikiId).to.equal(`project-${workspace.id}`);
      expect(registry.list().map((w) => w.id)).to.deep.equal([`project-${workspace.id}`]);

      const index = readFileSync(join(wikiRoot, `project-${workspace.id}`, 'index.md'), 'utf8');
      expect(index.startsWith('---'), 'index.md should begin with YAML frontmatter').to.equal(true);
      expect(index).to.contain('type: ephemeral');
      expect(index).to.contain('status: active');
    });

    it('destroys the wiki domain when the DB insert fails (no orphaned directories)', async () => {
      const failing = Object.create(store) as WorkspaceStore;
      failing.createProject = () => {
        throw new Error('boom');
      };

      // The workspace directory is created before the injected failure and the
      // handler intentionally leaves it in place — clean it up ourselves.
      const directoryName = `wiki-rollback-${randomUUID()}`;
      workspaceDirs.push(join(tmpdir(), 'projects', directoryName));

      const result = await createProjectHandler(
        failing,
        {
          name: 'My Project',
          locationRoot: 'temporary',
          directoryName,
          winCondition: 'It ships',
        },
        registry,
      );

      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(500);
        expect(result.error).to.include('boom');
      }
      expect(registry.list(), 'registry should hold no entries after rollback').to.have.length(0);
      const wikiDirs = readdirSync(wikiRoot).filter((entry) => entry.startsWith('project-'));
      expect(wikiDirs, 'no orphaned project wiki directory should remain').to.have.length(0);
      expect(store.listProjects()).to.have.length(0);
    });

    it('returns 400 when locationRoot is missing', async () => {
      const result = await createProjectHandler(store, {
        name: 'My Project',
        directoryName: 'my-project',
        winCondition: 'It ships',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.include('locationRoot');
      }
    });

    it('returns 400 when directoryName is missing', async () => {
      const result = await createProjectHandler(store, {
        name: 'My Project',
        locationRoot: 'projects',
        winCondition: 'It ships',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.include('directoryName');
      }
    });

    it('returns 400 when directoryName is a path traversal attempt', async () => {
      const result = await createProjectHandler(store, {
        name: 'My Project',
        locationRoot: 'projects',
        directoryName: '../../etc',
        winCondition: 'It ships',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.include('Invalid directoryName');
      }
    });

    it('still returns 400 when winCondition is missing (pre-existing check, unaffected)', async () => {
      const result = await createProjectHandler(store, {
        name: 'My Project',
        locationRoot: 'projects',
        directoryName: 'my-project',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.include('winCondition');
      }
    });
  });

  describe('patchProjectHandler()', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'projects-handlers-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns 400 when the patch tries to change the locked wiki_id', () => {
      const { workspace } = store.createProject({
        id: randomUUID(),
        name: 'My Project',
        location: join(dir, 'ws'),
        winCondition: 'It ships',
        wikiId: 'project-abc',
      });

      const result = patchProjectHandler(store, workspace.id, { wikiId: 'something-else' });
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.include('locked');
      }
      expect(store.getWorkspace(workspace.id)?.wikiId).to.equal('project-abc');
    });

    it('still applies patches that do not touch wiki_id', () => {
      const { workspace } = store.createProject({
        id: randomUUID(),
        name: 'My Project',
        location: join(dir, 'ws'),
        winCondition: 'It ships',
        wikiId: 'project-abc',
      });

      const result = patchProjectHandler(store, workspace.id, { winCondition: 'It ships v2' });
      expect(result.ok).to.equal(true);
    });
  });

  describe('slugify()', () => {
    it('lowercases and hyphenates non-alphanumeric runs', () => {
      expect(slugify('My Fancy Project!')).to.equal('my-fancy-project');
      expect(slugify('  spaced   out  ')).to.equal('spaced-out');
      expect(slugify('already-slugged')).to.equal('already-slugged');
    });
  });
});
