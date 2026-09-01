import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { WorkspaceStore } from '../../services/workspace-store.js';
import type { ExecFileFn } from '../../services/workspace-provision.js';
import type { HandlerResult } from './threads.handlers.js';
import { getFileTreeHandler } from './workspace-files.handlers.js';
import {
  getGitStatusHandler,
  listBranchesHandler,
  fetchHandler,
  syncHandler,
  pushHandler,
  checkoutHandler,
  createBranchHandler,
} from './workspace-git.handlers.js';

describe('routes/v1/workspace-git.handlers', () => {
  let store: WorkspaceStore;
  let dir: string;
  let workspaceDirs: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-git-handlers-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    store = new WorkspaceStore(db);
    workspaceDirs = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const wsDir of workspaceDirs) rmSync(wsDir, { recursive: true, force: true });
  });

  function makeWorkspace(opts: { git?: boolean } = {}) {
    const location = mkdtempSync(join(tmpdir(), 'workspace-git-ws-'));
    workspaceDirs.push(location);
    return store.createWorkspace({ name: 'WS', location, git: !!opts.git });
  }

  const HANDLERS: Array<{
    name: string;
    invoke: (id: string, execFileFn?: ExecFileFn) => Promise<HandlerResult<unknown>>;
  }> = [
    { name: 'getGitStatusHandler', invoke: (id, f) => getGitStatusHandler(store, id, f) },
    { name: 'listBranchesHandler', invoke: (id, f) => listBranchesHandler(store, id, f) },
    { name: 'fetchHandler', invoke: (id, f) => fetchHandler(store, id, f) },
    { name: 'syncHandler', invoke: (id, f) => syncHandler(store, id, f) },
    { name: 'pushHandler', invoke: (id, f) => pushHandler(store, id, f) },
    {
      name: 'checkoutHandler',
      invoke: (id, f) => checkoutHandler(store, id, { branch: 'main' }, f),
    },
    {
      name: 'createBranchHandler',
      invoke: (id, f) => createBranchHandler(store, id, { name: 'feature-x' }, f),
    },
  ];

  describe('404/400 guards (every handler)', () => {
    for (const { name, invoke } of HANDLERS) {
      it(`${name}: returns 404 for an unknown workspace`, async () => {
        const result = await invoke('does-not-exist');
        expect(result.ok).to.equal(false);
        if (!result.ok) expect(result.status).to.equal(404);
      });

      it(`${name}: returns 400 when the workspace has git disabled`, async () => {
        const ws = makeWorkspace({ git: false });
        const result = await invoke(ws.id);
        expect(result.ok).to.equal(false);
        if (!result.ok) expect(result.status).to.equal(400);
      });
    }
  });

  describe('getGitStatusHandler()', () => {
    it('returns parsed status for a git-enabled workspace', async () => {
      const ws = makeWorkspace({ git: true });
      const execFileFn = (async () => ({
        stdout: '# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n',
        stderr: '',
      })) as unknown as ExecFileFn;

      const result = await getGitStatusHandler(store, ws.id, execFileFn);
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.branch).to.equal('main');
        expect(result.data.hasRemote).to.equal(true);
      }
    });

    it('returns 400 with the underlying git error on failure', async () => {
      const ws = makeWorkspace({ git: true });
      const execFileFn = (async () => {
        throw new Error('git not found');
      }) as unknown as ExecFileFn;

      const result = await getGitStatusHandler(store, ws.id, execFileFn);
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.equal('git not found');
      }
    });
  });

  describe('listBranchesHandler()', () => {
    it('returns parsed local/remote branches', async () => {
      const ws = makeWorkspace({ git: true });
      const execFileFn = (async () => ({
        stdout: 'refs/heads/main\nrefs/remotes/origin/main\n',
        stderr: '',
      })) as unknown as ExecFileFn;

      const result = await listBranchesHandler(store, ws.id, execFileFn);
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.local).to.deep.equal(['main']);
        expect(result.data.remote).to.deep.equal(['origin/main']);
      }
    });
  });

  describe('checkoutHandler()', () => {
    it('returns 400 when branch is missing from the body', async () => {
      const ws = makeWorkspace({ git: true });
      const result = await checkoutHandler(store, ws.id, {});
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('checks out the branch and returns fresh status on success', async () => {
      const ws = makeWorkspace({ git: true });
      const execFileFn = (async () => ({ stdout: '', stderr: '' })) as unknown as ExecFileFn;

      const result = await checkoutHandler(store, ws.id, { branch: 'main' }, execFileFn);
      expect(result.ok).to.equal(true);
    });
  });

  describe('createBranchHandler()', () => {
    it('returns 400 when name is missing from the body', async () => {
      const ws = makeWorkspace({ git: true });
      const result = await createBranchHandler(store, ws.id, {});
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('creates the branch and returns fresh status on success', async () => {
      const ws = makeWorkspace({ git: true });
      const execFileFn = (async () => ({ stdout: '', stderr: '' })) as unknown as ExecFileFn;

      const result = await createBranchHandler(store, ws.id, { name: 'feature-x' }, execFileFn);
      expect(result.ok).to.equal(true);
    });
  });

  describe('syncHandler()', () => {
    it('returns 400 with the underlying git error when fast-forward fails', async () => {
      const ws = makeWorkspace({ git: true });
      const execFileFn = (async (_cmd: string, args: unknown) => {
        if (Array.isArray(args) && args[0] === 'merge') {
          throw new Error('fatal: Not possible to fast-forward, aborting.');
        }
        return { stdout: '', stderr: '' };
      }) as unknown as ExecFileFn;

      const result = await syncHandler(store, ws.id, execFileFn);
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(400);
        expect(result.error).to.equal('fatal: Not possible to fast-forward, aborting.');
      }
    });
  });

  describe('cache invalidation on a successful mutation', () => {
    it('invalidates the file tree cache so a follow-up tree fetch reflects a disk change', async () => {
      const ws = makeWorkspace({ git: true });

      let branchCall = 0;
      const treeExecFileFn = (async () => {
        branchCall++;
        return branchCall % 2 === 1 ? { stdout: 'main\n', stderr: '' } : { stdout: '', stderr: '' };
      }) as unknown as ExecFileFn;

      const before = await getFileTreeHandler(store, ws.id, treeExecFileFn);
      expect(before.ok, 'primes the cache').to.equal(true);

      writeFileSync(join(ws.location, 'brand-new.txt'), 'hi');

      const fetchExecFileFn = (async () => ({ stdout: '', stderr: '' })) as unknown as ExecFileFn;
      const mutation = await fetchHandler(store, ws.id, fetchExecFileFn);
      expect(mutation.ok).to.equal(true);

      const after = await getFileTreeHandler(store, ws.id, treeExecFileFn);
      expect(after.ok).to.equal(true);
      if (after.ok) {
        expect(after.data.entries.map((n) => n.name)).to.include('brand-new.txt');
      }
    });
  });

  describe('concurrency', () => {
    it('returns 409 when a mutating call overlaps another on the same workspace', async () => {
      const ws = makeWorkspace({ git: true });

      let releaseFirst: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      const firstExecFileFn = (async () => {
        await gate;
        return { stdout: '', stderr: '' };
      }) as unknown as ExecFileFn;

      const firstCall = fetchHandler(store, ws.id, firstExecFileFn);

      // Give the first call's synchronous prefix (through withLock's
      // locked.add) a tick to run before firing the second.
      await new Promise((resolve) => setImmediate(resolve));

      const secondExecFileFn = (async () => ({ stdout: '', stderr: '' })) as unknown as ExecFileFn;
      const second = await fetchHandler(store, ws.id, secondExecFileFn);

      expect(second.ok).to.equal(false);
      if (!second.ok) expect(second.status).to.equal(409);

      releaseFirst?.();
      const first = await firstCall;
      expect(first.ok).to.equal(true);
    });
  });
});
