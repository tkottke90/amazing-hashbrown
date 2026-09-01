import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

      const result = await deleteWorkspaceHandler(store, id, registry);
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

      const result = await deleteWorkspaceHandler(store, ws.id, registry);
      expect(result.ok).to.equal(true);
      expect(existsSync(join(wikiRoot, 'manual-wiki')), 'wiki directory should survive').to.equal(
        true,
      );
      expect(registry.list().map((w) => w.id)).to.deep.equal(['manual-wiki']);
    });

    it('returns 404 for an unknown workspace id', async () => {
      const result = await deleteWorkspaceHandler(store, 'does-not-exist', registry);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
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
