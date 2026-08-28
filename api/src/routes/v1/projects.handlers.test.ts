import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { createWikiRegistry, type WikiRegistry } from '@tkottke90/llm-wiki';
import { WorkspaceStore } from '../../services/workspace-store.js';
import type { ExecFileFn } from '../../services/workspace-provision.js';
import {
  createProjectHandler,
  patchProjectHandler,
  closeProjectHandler,
  snapshotProjectHandler,
  completeCloseProjectHandler,
  slugify,
} from './projects.handlers.js';

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

    it('returns 409 when a workspace with the same name already exists', async () => {
      const first = await createProjectHandler(
        store,
        {
          name: 'My Project',
          locationRoot: 'temporary',
          directoryName: `dup-project-${randomUUID()}`,
          winCondition: 'It ships',
        },
        registry,
      );
      expect(first.ok, `expected success, got: ${JSON.stringify(first)}`).to.equal(true);
      if (first.ok) workspaceDirs.push(first.data.workspace.location);

      const result = await createProjectHandler(
        store,
        {
          name: 'My Project',
          locationRoot: 'temporary',
          directoryName: `dup-project-${randomUUID()}`,
          winCondition: 'It ships',
        },
        registry,
      );
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(409);
        expect(result.error).to.include('My Project');
      }
      // Confirm the conflict was caught before an ephemeral wiki was provisioned.
      expect(registry.list()).to.have.length(1);
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

    it('creates the project with javascript/python set when provisioning succeeds', async () => {
      const calls: unknown[][] = [];
      const execFileFn = (async (...args: unknown[]) => {
        calls.push(args);
        return { stdout: '', stderr: '' };
      }) as unknown as ExecFileFn;

      const directoryName = `provision-project-ok-${randomUUID()}`;
      const location = join(tmpdir(), 'projects', directoryName);
      workspaceDirs.push(location);

      const result = await createProjectHandler(
        store,
        {
          name: 'Provisioned Project',
          locationRoot: 'temporary',
          directoryName,
          winCondition: 'It ships',
          javascript: true,
          python: true,
        },
        registry,
        execFileFn,
      );

      expect(result.ok, `expected success, got: ${JSON.stringify(result)}`).to.equal(true);
      if (result.ok) {
        expect(result.data.workspace.javascript).to.equal(true);
        expect(result.data.workspace.python).to.equal(true);
      }
      expect(calls.length).to.equal(2);
      expect(existsSync(location)).to.equal(true);
    });

    it('rolls back the directory and returns 400 when provisioning fails, before the wiki domain is created', async () => {
      const execFileFn = (async () => {
        throw new Error('npm not found');
      }) as unknown as ExecFileFn;

      const directoryName = `provision-project-fail-${randomUUID()}`;
      const location = join(tmpdir(), 'projects', directoryName);
      workspaceDirs.push(location);

      const result = await createProjectHandler(
        store,
        {
          name: 'Failed Project',
          locationRoot: 'temporary',
          directoryName,
          winCondition: 'It ships',
          javascript: true,
        },
        registry,
        execFileFn,
      );

      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.include('Failed to provision dependency isolation');
        expect(result.error).to.include('npm not found');
      }
      expect(existsSync(location)).to.equal(false);
      expect(registry.list(), 'no wiki domain should have been created').to.have.length(0);
      expect(store.listProjects()).to.have.length(0);
    });
  });

  describe('closeProjectHandler()', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'projects-handlers-close-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns 400 when intent is missing or invalid', () => {
      const { workspace } = store.createProject({
        id: randomUUID(),
        name: 'My Project',
        location: join(dir, 'ws'),
        winCondition: 'It ships',
      });
      const result = closeProjectHandler(store, workspace.id, {});
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.include('intent');
      }
    });

    it('moves an active project to closing and records the intent', () => {
      const { workspace } = store.createProject({
        id: randomUUID(),
        name: 'My Project',
        location: join(dir, 'ws'),
        winCondition: 'It ships',
      });
      const result = closeProjectHandler(store, workspace.id, { intent: 'close' });
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.status).to.equal('closing');
        expect(result.data.closeIntent).to.equal('close');
      }
    });

    it('accepts "abandon" as an intent', () => {
      const { workspace } = store.createProject({
        id: randomUUID(),
        name: 'My Project',
        location: join(dir, 'ws'),
        winCondition: 'It ships',
      });
      const result = closeProjectHandler(store, workspace.id, { intent: 'abandon' });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.closeIntent).to.equal('abandon');
    });

    it('returns 409 when the project is not active', () => {
      const { workspace } = store.createProject({
        id: randomUUID(),
        name: 'My Project',
        location: join(dir, 'ws'),
        winCondition: 'It ships',
      });
      closeProjectHandler(store, workspace.id, { intent: 'close' });
      const second = closeProjectHandler(store, workspace.id, { intent: 'close' });
      expect(second.ok).to.equal(false);
      if (!second.ok) expect(second.status).to.equal(409);
    });
  });

  describe('snapshotProjectHandler()', () => {
    let store: WorkspaceStore;
    let registry: WikiRegistry;
    let dir: string;
    let wikiRoot: string;
    let workspaceDirs: string[];

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'projects-handlers-snapshot-test-'));
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

    async function createClosingProject(opts: { git?: boolean } = {}) {
      const created = await createProjectHandler(
        store,
        {
          name: `Snapshot Project ${randomUUID()}`,
          locationRoot: 'temporary',
          directoryName: `snapshot-test-${randomUUID()}`,
          winCondition: 'It ships',
          git: !!opts.git,
        },
        registry,
      );
      if (!created.ok) throw new Error(`setup failed: ${JSON.stringify(created)}`);
      workspaceDirs.push(created.data.workspace.location);
      store.closeProject(created.data.workspace.id, 'close');
      return created.data.workspace;
    }

    it('returns 409 when the project is not in the closing state', async () => {
      const created = await createProjectHandler(
        store,
        {
          name: 'Active Project',
          locationRoot: 'temporary',
          directoryName: `snapshot-active-${randomUUID()}`,
          winCondition: 'It ships',
        },
        registry,
      );
      if (!created.ok) throw new Error('setup failed');
      workspaceDirs.push(created.data.workspace.location);

      const result = await snapshotProjectHandler(store, created.data.workspace.id, registry);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(409);
    });

    it('copies the wiki domain to a timestamped folder for a non-git workspace', async () => {
      const workspace = await createClosingProject();
      const result = await snapshotProjectHandler(store, workspace.id, registry);
      expect(result.ok, `expected success, got: ${JSON.stringify(result)}`).to.equal(true);
      if (!result.ok) return;
      expect(result.data.snapshotPath).to.match(/wiki-snapshot-\d{4}-\d{2}-\d{2}$/);
      expect(existsSync(join(result.data.snapshotPath, 'index.md'))).to.equal(true);
      expect(store.getProject(workspace.id)?.snapshotPath).to.equal(result.data.snapshotPath);
    });

    it('is idempotent — a second call returns the same path without re-copying', async () => {
      const workspace = await createClosingProject();
      const first = await snapshotProjectHandler(store, workspace.id, registry);
      if (!first.ok) throw new Error('setup failed');
      const second = await snapshotProjectHandler(store, workspace.id, registry);
      expect(second.ok).to.equal(true);
      if (second.ok) expect(second.data.snapshotPath).to.equal(first.data.snapshotPath);
    });

    it('commits the wiki directory via git for a git-connected workspace', async () => {
      const workspace = await createClosingProject({ git: true });
      const calls: unknown[][] = [];
      const execFileFn = (async (...args: unknown[]) => {
        calls.push(args);
        return { stdout: '', stderr: '' };
      }) as unknown as ExecFileFn;

      const result = await snapshotProjectHandler(store, workspace.id, registry, execFileFn);
      expect(result.ok, `expected success, got: ${JSON.stringify(result)}`).to.equal(true);
      if (!result.ok) return;
      expect(result.data.snapshotPath).to.equal(join(workspace.location, 'wiki'));
      expect(existsSync(join(workspace.location, 'wiki', 'index.md'))).to.equal(true);
      expect(calls).to.deep.equal([
        ['git', ['add', 'wiki'], { cwd: workspace.location, timeout: 15_000 }],
        [
          'git',
          ['commit', '-m', 'Snapshot project wiki on close'],
          { cwd: workspace.location, timeout: 15_000 },
        ],
      ]);
    });
  });

  describe('completeCloseProjectHandler()', () => {
    let store: WorkspaceStore;
    let registry: WikiRegistry;
    let dir: string;
    let wikiRoot: string;
    let workspaceDirs: string[];

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'projects-handlers-complete-close-test-'));
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

    async function createClosingProjectWithPage(intent: 'close' | 'abandon' = 'close') {
      const created = await createProjectHandler(
        store,
        {
          name: `Complete Close Project ${randomUUID()}`,
          locationRoot: 'temporary',
          directoryName: `complete-close-test-${randomUUID()}`,
          winCondition: 'It ships',
        },
        registry,
      );
      if (!created.ok) throw new Error(`setup failed: ${JSON.stringify(created)}`);
      workspaceDirs.push(created.data.workspace.location);
      const { workspace } = created.data;

      const wiki = await registry.load(workspace.wikiId!);
      await wiki.commitPage({
        type: 'entity',
        title: 'Learnings',
        tags: [],
        sources: [],
        body: 'Something we learned.',
      });

      store.closeProject(workspace.id, intent);
      return workspace;
    }

    it('returns 409 when the project is not in the closing state', async () => {
      const created = await createProjectHandler(
        store,
        {
          name: 'Active Project',
          locationRoot: 'temporary',
          directoryName: `complete-close-active-${randomUUID()}`,
          winCondition: 'It ships',
        },
        registry,
      );
      if (!created.ok) throw new Error('setup failed');
      workspaceDirs.push(created.data.workspace.location);

      const result = await completeCloseProjectHandler(store, created.data.workspace.id, registry);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(409);
    });

    it('merges selected pages, archives the domain, and sets the terminal status from close_intent', async () => {
      const workspace = await createClosingProjectWithPage('close');
      await registry.create({ id: 'target-domain', domain: 'target', tags: [] });

      store.patchProject(workspace.id, {
        closeProgress: {
          mergeSelections: [{ filename: 'entities/learnings.md', targetDomainId: 'target-domain' }],
        },
      });

      const result = await completeCloseProjectHandler(store, workspace.id, registry);
      expect(result.ok, `expected success, got: ${JSON.stringify(result)}`).to.equal(true);
      if (!result.ok) return;
      expect(result.data.succeeded).to.deep.equal(['entities/learnings.md']);
      expect(result.data.failed).to.deep.equal([]);

      const targetWiki = await registry.load('target-domain');
      const merged = await targetWiki.readPage('entities/learnings.md');
      expect(merged.content).to.contain('Something we learned.');

      const project = store.getProject(workspace.id)!;
      expect(project.status).to.equal('closed');
      expect(project.closedAt).to.not.equal(null);
      expect(project.closeProgress).to.equal(null);

      const sourceWiki = await registry.load(workspace.wikiId!);
      const { index } = await sourceWiki.orient();
      expect(index).to.match(/status:\s*archived/);
      expect(registry.list()).to.not.include.members([workspace.wikiId]);
    });

    it('sets status to abandoned when close_intent is abandon', async () => {
      const workspace = await createClosingProjectWithPage('abandon');
      store.patchProject(workspace.id, { closeProgress: { mergeSelections: [] } });

      const result = await completeCloseProjectHandler(store, workspace.id, registry);
      expect(result.ok).to.equal(true);
      expect(store.getProject(workspace.id)?.status).to.equal('abandoned');
    });

    it('leaves the project in closing and reports failures when a merge target does not exist', async () => {
      const workspace = await createClosingProjectWithPage('close');
      store.patchProject(workspace.id, {
        closeProgress: {
          mergeSelections: [{ filename: 'entities/learnings.md', targetDomainId: 'nonexistent' }],
        },
      });

      const result = await completeCloseProjectHandler(store, workspace.id, registry);
      expect(result.ok, `expected success, got: ${JSON.stringify(result)}`).to.equal(true);
      if (!result.ok) return;
      expect(result.data.succeeded).to.deep.equal([]);
      expect(result.data.failed).to.have.length(1);
      expect(result.data.failed[0]?.filename).to.equal('entities/learnings.md');

      expect(store.getProject(workspace.id)?.status).to.equal('closing');
    });

    it('rejects merging into an already-archived (closed) target domain', async () => {
      const workspace = await createClosingProjectWithPage('close');
      const otherCreated = await createProjectHandler(
        store,
        {
          name: `Other Project ${randomUUID()}`,
          locationRoot: 'temporary',
          directoryName: `other-project-${randomUUID()}`,
          winCondition: 'It ships',
        },
        registry,
      );
      if (!otherCreated.ok) throw new Error('setup failed');
      workspaceDirs.push(otherCreated.data.workspace.location);
      store.closeProject(otherCreated.data.workspace.id, 'close');
      store.patchProject(otherCreated.data.workspace.id, {
        closeProgress: { mergeSelections: [] },
      });
      await completeCloseProjectHandler(store, otherCreated.data.workspace.id, registry);

      store.patchProject(workspace.id, {
        closeProgress: {
          mergeSelections: [
            {
              filename: 'entities/learnings.md',
              targetDomainId: otherCreated.data.workspace.wikiId!,
            },
          ],
        },
      });

      const result = await completeCloseProjectHandler(store, workspace.id, registry);
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.failed).to.have.length(1);
        expect(result.data.failed[0]?.error).to.include('archived');
      }
      expect(store.getProject(workspace.id)?.status).to.equal('closing');
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
