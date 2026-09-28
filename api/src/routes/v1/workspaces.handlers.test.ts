import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { createWikiRegistry, type WikiRegistry } from '@tkottke90/llm-wiki';
import { WorkspaceStore } from '../../services/workspace-store.js';
import type { ExecFileFn } from '../../services/workspace-provision.js';
import {
  createWorkspaceHandler,
  deleteWorkspaceHandler,
  getWorkspaceHandler,
  listWorkspacesHandler,
  patchWorkspaceHandler,
  cleanupDependenciesHandler,
} from './workspaces.handlers.js';

describe('routes/v1/workspaces.handlers', () => {
  describe('createWorkspaceHandler()', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspaces-handlers-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns 400 when name is missing', async () => {
      const result = await createWorkspaceHandler(store, {
        locationRoot: 'projects',
        directoryName: 'my-workspace',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('returns 400 when locationRoot is missing', async () => {
      const result = await createWorkspaceHandler(store, {
        name: 'My Workspace',
        directoryName: 'my-workspace',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.include('locationRoot');
      }
    });

    it('returns 400 when locationRoot is not "projects" or "temporary"', async () => {
      const result = await createWorkspaceHandler(store, {
        name: 'My Workspace',
        locationRoot: 'somewhere-else',
        directoryName: 'my-workspace',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('returns 400 when directoryName is missing', async () => {
      const result = await createWorkspaceHandler(store, {
        name: 'My Workspace',
        locationRoot: 'projects',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.include('directoryName');
      }
    });

    it('returns 400 when directoryName is a path traversal attempt', async () => {
      const result = await createWorkspaceHandler(store, {
        name: 'My Workspace',
        locationRoot: 'projects',
        directoryName: '../../etc',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.include('Invalid directoryName');
      }
    });

    describe('directory collision (409)', () => {
      const workspaceDirs: string[] = [];

      afterEach(() => {
        for (const wsDir of workspaceDirs.splice(0))
          rmSync(wsDir, { recursive: true, force: true });
      });

      it('returns 409 naming the leftover directory when the slug is already taken on disk [unit]', async () => {
        const directoryName = `leftover-${randomUUID()}`;
        const location = join(tmpdir(), 'projects', directoryName);
        workspaceDirs.push(location);
        mkdirSync(location, { recursive: true });

        const result = await createWorkspaceHandler(store, {
          name: 'Collides On Disk',
          locationRoot: 'temporary',
          directoryName,
        });

        expect(result.ok).to.equal(false);
        if (!result.ok) {
          expect(result.status).to.equal(409);
          expect(result.error, 'the user needs the path to clean it up').to.include(location);
        }
      });
    });

    describe('name uniqueness (409)', () => {
      const workspaceDirs: string[] = [];

      afterEach(() => {
        for (const wsDir of workspaceDirs.splice(0))
          rmSync(wsDir, { recursive: true, force: true });
      });

      it('returns 409 when a workspace with the same name already exists', async () => {
        const dirA = `dup-name-${randomUUID()}`;
        const dirB = `dup-name-${randomUUID()}`;
        workspaceDirs.push(join(tmpdir(), 'projects', dirA), join(tmpdir(), 'projects', dirB));

        const first = await createWorkspaceHandler(store, {
          name: 'My Workspace',
          locationRoot: 'temporary',
          directoryName: dirA,
        });
        expect(first.ok).to.equal(true);

        const result = await createWorkspaceHandler(store, {
          name: 'My Workspace',
          locationRoot: 'temporary',
          directoryName: dirB,
        });
        expect(result.ok).to.equal(false);
        if (!result.ok) {
          expect(result.status).to.equal(409);
          expect(result.error).to.include('My Workspace');
        }
      });

      it('returns 409 for a name that only differs by case', async () => {
        const dirA = `dup-name-case-${randomUUID()}`;
        const dirB = `dup-name-case-${randomUUID()}`;
        workspaceDirs.push(join(tmpdir(), 'projects', dirA), join(tmpdir(), 'projects', dirB));

        const first = await createWorkspaceHandler(store, {
          name: 'My Workspace',
          locationRoot: 'temporary',
          directoryName: dirA,
        });
        expect(first.ok).to.equal(true);

        const result = await createWorkspaceHandler(store, {
          name: 'MY WORKSPACE',
          locationRoot: 'temporary',
          directoryName: dirB,
        });
        expect(result.ok).to.equal(false);
        if (!result.ok) expect(result.status).to.equal(409);
      });
    });
  });

  describe('createWorkspaceHandler() dependency isolation provisioning', () => {
    let store: WorkspaceStore;
    let dir: string;
    let workspaceDirs: string[];

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspaces-handlers-provision-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
      workspaceDirs = [];
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      for (const wsDir of workspaceDirs) rmSync(wsDir, { recursive: true, force: true });
    });

    it('creates the workspace with javascript/python set when provisioning succeeds', async () => {
      const calls: unknown[][] = [];
      const execFileFn = (async (...args: unknown[]) => {
        calls.push(args);
        return { stdout: '', stderr: '' };
      }) as unknown as ExecFileFn;

      const directoryName = `provision-ws-ok-${randomUUID()}`;
      const location = join(tmpdir(), 'projects', directoryName);
      workspaceDirs.push(location);

      const result = await createWorkspaceHandler(
        store,
        {
          name: 'Provisioned Workspace',
          locationRoot: 'temporary',
          directoryName,
          javascript: true,
          python: true,
        },
        execFileFn,
      );

      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data?.javascript).to.equal(true);
        expect(result.data?.python).to.equal(true);
      }
      expect(calls.length).to.equal(2);
      expect(existsSync(location)).to.equal(true);
    });

    it('rolls back the directory and returns 400 when provisioning fails', async () => {
      const execFileFn = (async () => {
        throw new Error('npm not found');
      }) as unknown as ExecFileFn;

      const directoryName = `provision-ws-fail-${randomUUID()}`;
      const location = join(tmpdir(), 'projects', directoryName);
      workspaceDirs.push(location);

      const result = await createWorkspaceHandler(
        store,
        {
          name: 'Failed Workspace',
          locationRoot: 'temporary',
          directoryName,
          javascript: true,
        },
        execFileFn,
      );

      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.include('Failed to provision dependency isolation');
        expect(result.error).to.include('npm not found');
      }
      expect(existsSync(location)).to.equal(false);
    });
  });

  describe('createWorkspaceHandler() git provisioning', () => {
    let store: WorkspaceStore;
    let dir: string;
    let workspaceDirs: string[];

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspaces-handlers-git-provision-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
      workspaceDirs = [];
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      for (const wsDir of workspaceDirs) rmSync(wsDir, { recursive: true, force: true });
    });

    it('runs git init before dependency isolation when git is true and no remoteUrl', async () => {
      const calls: unknown[][] = [];
      const execFileFn = (async (...args: unknown[]) => {
        calls.push(args);
        return { stdout: '', stderr: '' };
      }) as unknown as ExecFileFn;

      const directoryName = `git-provision-init-${randomUUID()}`;
      const location = join(tmpdir(), 'projects', directoryName);
      workspaceDirs.push(location);

      const result = await createWorkspaceHandler(
        store,
        {
          name: 'Git Init Workspace',
          locationRoot: 'temporary',
          directoryName,
          git: true,
          javascript: true,
        },
        execFileFn,
      );

      expect(result.ok).to.equal(true);
      expect(calls.length).to.equal(2);
      expect(calls[0]).to.deep.equal(['git', ['init'], { cwd: location, timeout: 10_000 }]);
      expect(calls[1]).to.deep.equal(['npm', ['init', '-y'], { cwd: location, timeout: 30_000 }]);
    });

    it('runs git clone before dependency isolation when git is true and remoteUrl is set', async () => {
      const calls: unknown[][] = [];
      const execFileFn = (async (...args: unknown[]) => {
        calls.push(args);
        return { stdout: '', stderr: '' };
      }) as unknown as ExecFileFn;

      const directoryName = `git-provision-clone-${randomUUID()}`;
      const location = join(tmpdir(), 'projects', directoryName);
      workspaceDirs.push(location);

      const result = await createWorkspaceHandler(
        store,
        {
          name: 'Git Clone Workspace',
          locationRoot: 'temporary',
          directoryName,
          git: true,
          remoteUrl: 'https://example.com/org/repo.git',
        },
        execFileFn,
      );

      expect(result.ok).to.equal(true);
      expect(calls).to.deep.equal([
        [
          'git',
          ['clone', '--', 'https://example.com/org/repo.git', '.'],
          { cwd: location, timeout: 60_000 },
        ],
      ]);
    });

    it('does not run any git command when git is false', async () => {
      const calls: unknown[][] = [];
      const execFileFn = (async (...args: unknown[]) => {
        calls.push(args);
        return { stdout: '', stderr: '' };
      }) as unknown as ExecFileFn;

      const directoryName = `git-provision-off-${randomUUID()}`;
      const location = join(tmpdir(), 'projects', directoryName);
      workspaceDirs.push(location);

      const result = await createWorkspaceHandler(
        store,
        {
          name: 'No Git Workspace',
          locationRoot: 'temporary',
          directoryName,
          git: false,
          remoteUrl: 'https://example.com/org/repo.git',
        },
        execFileFn,
      );

      expect(result.ok).to.equal(true);
      expect(calls.length).to.equal(0);
    });

    it('rolls back the directory and returns 400 when git provisioning fails', async () => {
      const execFileFn = (async () => {
        throw new Error('Repository not found');
      }) as unknown as ExecFileFn;

      const directoryName = `git-provision-fail-${randomUUID()}`;
      const location = join(tmpdir(), 'projects', directoryName);
      workspaceDirs.push(location);

      const result = await createWorkspaceHandler(
        store,
        {
          name: 'Failed Git Workspace',
          locationRoot: 'temporary',
          directoryName,
          git: true,
          remoteUrl: 'https://example.com/org/nope.git',
        },
        execFileFn,
      );

      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.include('Failed to provision git repository');
        expect(result.error).to.include('Repository not found');
      }
      expect(existsSync(location)).to.equal(false);
    });
  });

  describe('patchWorkspaceHandler() wiki_id lock', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspaces-handlers-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns 400 when changing wiki_id on a workspace with a project attached', () => {
      const { workspace } = store.createProject({
        id: randomUUID(),
        name: 'My Project',
        location: join(dir, 'ws'),
        winCondition: 'It ships',
        wikiId: 'project-abc',
      });

      const result = patchWorkspaceHandler(store, workspace.id, { wikiId: 'other' });
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.include('locked');
      }
      expect(store.getWorkspace(workspace.id)?.wikiId).to.equal('project-abc');
    });

    it('still allows wiki_id changes on a workspace without a project', () => {
      const ws = store.createWorkspace({ name: 'Plain', location: join(dir, 'ws') });
      const result = patchWorkspaceHandler(store, ws.id, { wikiId: 'manual-wiki' });
      expect(result.ok).to.equal(true);
      expect(store.getWorkspace(ws.id)?.wikiId).to.equal('manual-wiki');
    });

    it('still allows non-wiki_id patches on a workspace with a project', () => {
      const { workspace } = store.createProject({
        id: randomUUID(),
        name: 'My Project',
        location: join(dir, 'ws'),
        winCondition: 'It ships',
        wikiId: 'project-abc',
      });

      const result = patchWorkspaceHandler(store, workspace.id, { name: 'Renamed' });
      expect(result.ok).to.equal(true);
      expect(store.getWorkspace(workspace.id)?.name).to.equal('Renamed');
    });
  });

  describe('createWorkspaceHandler() new dedicated wiki (#202)', () => {
    let store: WorkspaceStore;
    let registry: WikiRegistry;
    let dir: string;
    let wikiRoot: string;
    let workspaceDirs: string[];

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'workspaces-handlers-new-wiki-test-'));
      wikiRoot = join(dir, 'wiki');
      store = new WorkspaceStore(openDatabase(join(dir, 'test.db')));
      registry = await createWikiRegistry({ wikiRoot });
      workspaceDirs = [];
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      for (const wsDir of workspaceDirs) rmSync(wsDir, { recursive: true, force: true });
    });

    function request(extra: Record<string, unknown>) {
      const directoryName = `new-wiki-ws-${randomUUID()}`;
      const location = join(tmpdir(), 'projects', directoryName);
      workspaceDirs.push(location);
      return {
        location,
        body: { name: 'Image Archive', locationRoot: 'temporary', directoryName, ...extra },
      };
    }

    it('creates a persistent (non-ephemeral) wiki and binds it to the new workspace [orchestration]', async () => {
      const { body } = request({ newWiki: { name: 'Image Archive Notes' } });

      const result = await createWorkspaceHandler(store, body, undefined, registry);

      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data.wikiId).to.equal('image-archive-notes');
      expect(registry.list().map((d) => d.id)).to.deep.equal(['image-archive-notes']);
      // Ephemeral project wikis carry `type: ephemeral` frontmatter; a
      // dedicated wiki must not, or project cleanup could treat it as one.
      const index = readFileSync(join(wikiRoot, 'image-archive-notes', 'index.md'), 'utf8');
      expect(index).to.not.contain('ephemeral');
    });

    it('returns 409 and creates nothing when the wiki id is already taken [orchestration]', async () => {
      await registry.create({ id: 'image-archive-notes', domain: 'existing' });
      const { body, location } = request({ newWiki: { name: 'Image Archive Notes' } });

      const result = await createWorkspaceHandler(store, body, undefined, registry);

      expect(result).to.deep.equal({
        ok: false,
        status: 409,
        error: 'A wiki named "image-archive-notes" already exists.',
      });
      expect(existsSync(location), 'collision is checked before the directory is made').to.equal(
        false,
      );
      expect(store.listWorkspaces()).to.have.length(0);
    });

    it('returns 400 when both newWiki and wikiId are sent [unit]', async () => {
      const { body, location } = request({ newWiki: { name: 'x' }, wikiId: 'user' });
      const result = await createWorkspaceHandler(store, body, undefined, registry);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
      expect(existsSync(location)).to.equal(false);
    });

    it('returns 400 when the wiki name has no letters or numbers [unit]', async () => {
      const { body, location } = request({ newWiki: { name: '!!!' } });
      const result = await createWorkspaceHandler(store, body, undefined, registry);
      expect(result).to.deep.equal({
        ok: false,
        status: 400,
        error: 'Wiki name must contain letters or numbers.',
      });
      expect(existsSync(location)).to.equal(false);
    });

    it('rolls back the directory and creates no workspace when the wiki cannot be created [orchestration]', async () => {
      const failing = {
        list: () => registry.list(),
        create: async () => {
          throw new Error('disk full');
        },
      } as unknown as WikiRegistry;
      const { body, location } = request({ newWiki: { name: 'Image Archive Notes' } });

      const result = await createWorkspaceHandler(store, body, undefined, failing);

      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(500);
        expect(result.error).to.include('disk full');
      }
      expect(existsSync(location)).to.equal(false);
      expect(store.listWorkspaces()).to.have.length(0);
    });

    it('destroys the new wiki and removes the directory when the workspace insert fails [orchestration]', async () => {
      const throwingStore = Object.create(store) as WorkspaceStore;
      throwingStore.createWorkspace = () => {
        throw new Error('database is locked');
      };
      const { body, location } = request({ newWiki: { name: 'Image Archive Notes' } });

      const result = await createWorkspaceHandler(throwingStore, body, undefined, registry);

      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(500);
      expect(registry.list(), 'no orphaned wiki may be left behind').to.have.length(0);
      expect(existsSync(location)).to.equal(false);
    });

    it('does not touch the wiki registry when no new wiki is requested [unit]', async () => {
      const { body } = request({});
      const result = await createWorkspaceHandler(store, body, undefined, registry);
      expect(result.ok).to.equal(true);
      expect(registry.list()).to.have.length(0);
    });
  });

  describe('deleteWorkspaceHandler()', () => {
    let store: WorkspaceStore;
    let registry: WikiRegistry;
    let dir: string;
    let wikiRoot: string;

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'workspaces-handlers-test-'));
      wikiRoot = join(dir, 'wiki');
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
      registry = await createWikiRegistry({ wikiRoot });
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('destroys the ephemeral wiki when deleting a workspace with a project', async () => {
      const id = randomUUID();
      const domainId = `project-${id}`;
      await registry.create({ id: domainId, domain: 'my-project' });
      store.createProject({
        id,
        name: 'My Project',
        location: join(dir, 'ws'),
        winCondition: 'It ships',
        wikiId: domainId,
      });

      const result = await deleteWorkspaceHandler(store, id, registry, [join(dir, 'root')]);
      expect(result.ok).to.equal(true);
      expect(store.getWorkspace(id)).to.equal(null);
      expect(existsSync(join(wikiRoot, domainId)), 'wiki directory should be removed').to.equal(
        false,
      );
      expect(registry.list()).to.have.length(0);
    });

    it('leaves a manually-set wiki untouched when deleting a project-less workspace', async () => {
      await registry.create({ id: 'manual-wiki', domain: 'notes' });
      const ws = store.createWorkspace({
        name: 'Plain',
        location: join(dir, 'ws'),
        wikiId: 'manual-wiki',
      });

      const result = await deleteWorkspaceHandler(store, ws.id, registry, [join(dir, 'root')]);
      expect(result.ok).to.equal(true);
      expect(existsSync(join(wikiRoot, 'manual-wiki')), 'wiki directory should survive').to.equal(
        true,
      );
      expect(registry.list().map((w) => w.id)).to.deep.equal(['manual-wiki']);
    });

    it('keeps a dedicated wiki and its pages after deleting the workspace that created it [orchestration]', async () => {
      // #202: unlike a project wiki, a wiki created alongside a workspace is
      // the long-lived home of that repo's notes — it must outlive the
      // workspace.
      const created = await createWorkspaceHandler(
        store,
        {
          name: 'Image Archive',
          locationRoot: 'temporary',
          directoryName: `keep-wiki-${randomUUID()}`,
          newWiki: { name: 'Image Archive' },
        },
        undefined,
        registry,
      );
      expect(created.ok).to.equal(true);
      if (!created.ok) return;
      const wiki = await registry.load('image-archive');
      await wiki.commitPage({
        type: 'concept',
        title: 'Upload Streaming',
        tags: [],
        sources: [],
        body: 'Uses stream.pipeline(). See [[dns]] and [[proxy]].',
      });

      const result = await deleteWorkspaceHandler(store, created.data.id, registry, [
        join(tmpdir(), 'projects'),
      ]);

      expect(result.ok).to.equal(true);
      expect(registry.list().map((w) => w.id)).to.deep.equal(['image-archive']);
      const page = await (
        await registry.load('image-archive')
      ).readPage('concepts/upload-streaming.md');
      expect(page.content).to.contain('stream.pipeline()');
    });

    it('removes the workspace directory when it sits under a managed root [orchestration]', async () => {
      const root = join(dir, 'root');
      const location = join(root, 'ws');
      mkdirSync(location, { recursive: true });
      writeFileSync(join(location, 'notes.md'), 'data');
      const ws = store.createWorkspace({ name: 'Managed', location });

      const result = await deleteWorkspaceHandler(store, ws.id, registry, [root]);

      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.directory).to.deep.equal({ removed: true, path: location });
      expect(existsSync(location), 'deleting a workspace should remove its directory').to.equal(
        false,
      );
    });

    it('deletes the workspace but keeps and reports a directory outside the managed roots [orchestration]', async () => {
      const location = join(dir, 'elsewhere', 'ws');
      mkdirSync(location, { recursive: true });
      writeFileSync(join(location, 'keep.txt'), 'data');
      const ws = store.createWorkspace({ name: 'Legacy', location });

      const result = await deleteWorkspaceHandler(store, ws.id, registry, [join(dir, 'root')]);

      expect(result.ok, 'an unmanaged directory must not block the delete').to.equal(true);
      if (result.ok) {
        expect(result.data.directory).to.deep.equal({
          removed: false,
          path: location,
          reason: 'outside-managed-roots',
        });
      }
      expect(store.getWorkspace(ws.id)).to.equal(null);
      expect(
        existsSync(join(location, 'keep.txt')),
        'files outside the managed roots must never be deleted',
      ).to.equal(true);
    });

    it('allows recreating a workspace with the same slug after deleting it (#204) [orchestration]', async () => {
      const directoryName = `recreate-${randomUUID()}`;
      const location = join(tmpdir(), 'projects', directoryName);
      try {
        const first = await createWorkspaceHandler(store, {
          name: 'Recreate Me',
          locationRoot: 'temporary',
          directoryName,
        });
        expect(first.ok).to.equal(true);
        if (!first.ok) return;

        const deleted = await deleteWorkspaceHandler(store, first.data.id, registry);
        expect(deleted.ok).to.equal(true);

        const second = await createWorkspaceHandler(store, {
          name: 'Recreate Me',
          locationRoot: 'temporary',
          directoryName,
        });
        expect(
          second.ok,
          `recreate should succeed once the old directory is gone: ${!second.ok ? second.error : ''}`,
        ).to.equal(true);
      } finally {
        rmSync(location, { recursive: true, force: true });
      }
    });

    it('returns 404 for an unknown workspace id', async () => {
      const result = await deleteWorkspaceHandler(store, 'does-not-exist', registry);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });
  });

  describe('managedLocation on workspace responses', () => {
    let store: WorkspaceStore;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspaces-handlers-managed-test-'));
      store = new WorkspaceStore(openDatabase(join(dir, 'test.db')));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    // tmpdir()/projects is the default temporary root, so a direct child of it
    // is managed; the mkdtemp dir itself is not a root, so a child of it isn't.
    const managedPath = () => join(tmpdir(), 'projects', `managed-${randomUUID()}`);

    it('marks a workspace under a managed root as managed on get [unit]', () => {
      const ws = store.createWorkspace({ name: 'Managed', location: managedPath() });
      const result = getWorkspaceHandler(store, ws.id);
      expect(result.ok && result.data.managedLocation).to.equal(true);
    });

    it('marks a legacy out-of-root workspace as unmanaged on get [unit]', () => {
      const ws = store.createWorkspace({ name: 'Legacy', location: join(dir, 'repo') });
      const result = getWorkspaceHandler(store, ws.id);
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.managedLocation).to.equal(false);
    });

    it('includes managedLocation on every listed workspace [unit]', () => {
      store.createWorkspace({ name: 'Managed', location: managedPath() });
      store.createWorkspace({ name: 'Legacy', location: join(dir, 'repo') });
      const result = listWorkspacesHandler(store);
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const byName = Object.fromEntries(result.data.map((w) => [w.name, w.managedLocation]));
        expect(byName).to.deep.equal({ Managed: true, Legacy: false });
      }
    });

    it('keeps managedLocation on a patched workspace so the UI never loses it [unit]', () => {
      const ws = store.createWorkspace({ name: 'Managed', location: managedPath() });
      const result = patchWorkspaceHandler(store, ws.id, { name: 'Renamed' });
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.managedLocation).to.equal(true);
    });
  });

  describe('cleanupDependenciesHandler()', () => {
    let store: WorkspaceStore;
    let dir: string;
    let location: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspaces-handlers-cleanup-test-'));
      const db = openDatabase(join(dir, 'test.db'));
      store = new WorkspaceStore(db);
      location = join(dir, 'ws');
      mkdirSync(location, { recursive: true });
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function seedDependencyDirs() {
      mkdirSync(join(location, 'node_modules', 'some-pkg'), { recursive: true });
      writeFileSync(join(location, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = {};');
      mkdirSync(join(location, '.venv', 'lib'), { recursive: true });
      writeFileSync(join(location, '.venv', 'lib', 'site.py'), 'x = 1\n');
    }

    it('returns 404 for an unknown workspace id', async () => {
      const result = await cleanupDependenciesHandler(store, 'does-not-exist', {});
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('dry run reports found directories with sizes without removing anything', async () => {
      seedDependencyDirs();
      const ws = store.createWorkspace({ name: 'W', location, javascript: true, python: true });

      const result = await cleanupDependenciesHandler(store, ws.id, {
        removeNodeModules: true,
        removePythonEnv: true,
        dryRun: true,
      });
      expect(result.ok, `expected success, got: ${JSON.stringify(result)}`).to.equal(true);
      if (!result.ok || result.data.dryRun === false) return;
      const paths = result.data.candidates.map((c) => c.path).sort();
      expect(paths).to.deep.equal(['.venv', 'node_modules']);
      for (const candidate of result.data.candidates) {
        expect(candidate.sizeBytes).to.be.greaterThan(0);
      }
      expect(existsSync(join(location, 'node_modules'))).to.equal(true);
      expect(existsSync(join(location, '.venv'))).to.equal(true);
    });

    it('reports only the requested category when the other flag is false', async () => {
      seedDependencyDirs();
      const ws = store.createWorkspace({ name: 'W', location, javascript: true, python: true });

      const result = await cleanupDependenciesHandler(store, ws.id, {
        removeNodeModules: true,
        removePythonEnv: false,
        dryRun: true,
      });
      expect(result.ok).to.equal(true);
      if (!result.ok || result.data.dryRun === false) return;
      expect(result.data.candidates.map((c) => c.path)).to.deep.equal(['node_modules']);
    });

    it('removes the selected directories and reports bytes freed', async () => {
      seedDependencyDirs();
      const ws = store.createWorkspace({ name: 'W', location, javascript: true, python: true });

      const result = await cleanupDependenciesHandler(store, ws.id, {
        removeNodeModules: true,
        removePythonEnv: true,
      });
      expect(result.ok, `expected success, got: ${JSON.stringify(result)}`).to.equal(true);
      if (!result.ok || result.data.dryRun === true) return;
      expect(result.data.removed.sort()).to.deep.equal(['.venv', 'node_modules']);
      expect(result.data.bytesFreed).to.be.greaterThan(0);
      expect(existsSync(join(location, 'node_modules'))).to.equal(false);
      expect(existsSync(join(location, '.venv'))).to.equal(false);
    });

    it('is a no-op when neither flag is set', async () => {
      seedDependencyDirs();
      const ws = store.createWorkspace({ name: 'W', location, javascript: true, python: true });

      const result = await cleanupDependenciesHandler(store, ws.id, {});
      expect(result.ok).to.equal(true);
      if (!result.ok || result.data.dryRun === true) return;
      expect(result.data.removed).to.deep.equal([]);
      expect(existsSync(join(location, 'node_modules'))).to.equal(true);
    });
  });
});
