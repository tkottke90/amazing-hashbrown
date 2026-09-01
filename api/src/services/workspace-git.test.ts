import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
  parseStatusPorcelainV2,
  getGitStatus,
  listBranches,
  fetchRemote,
  syncFastForward,
  pushBranch,
  checkoutBranch,
  createBranch,
  withLock,
  GitOperationInProgressError,
  type GitStatus,
} from './workspace-git.js';
import type { ExecFileFn } from './workspace-provision.js';

// Same shape as workspace-provision.test.ts's makeStub, but impl gets the
// full args tuple so a test can branch behavior per git subcommand (e.g.
// pushBranch's "has an upstream?" probe vs. the push itself).
function makeStub(impl?: (...args: Parameters<ExecFileFn>) => unknown) {
  const calls: unknown[][] = [];
  const stub = (async (...args: Parameters<ExecFileFn>) => {
    calls.push(args);
    if (impl) return impl(...args);
    return { stdout: '', stderr: '' };
  }) as unknown as ExecFileFn;
  return { stub, calls };
}

describe('services/workspace-git', () => {
  describe('parseStatusPorcelainV2()', () => {
    it('parses a clean branch with an upstream, no ahead/behind', () => {
      const output = [
        '# branch.oid abc123',
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab +0 -0',
        '',
      ].join('\n');
      const result: GitStatus = parseStatusPorcelainV2(output);
      expect(result).to.deep.equal({
        branch: 'main',
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        hasRemote: true,
        dirty: false,
      });
    });

    it('parses ahead/behind counts', () => {
      const output = [
        '# branch.oid abc123',
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab +2 -5',
        '',
      ].join('\n');
      const result = parseStatusPorcelainV2(output);
      expect(result.ahead).to.equal(2);
      expect(result.behind).to.equal(5);
    });

    it('parses a branch with no upstream configured', () => {
      const output = ['# branch.oid abc123', '# branch.head feature-x', ''].join('\n');
      const result = parseStatusPorcelainV2(output);
      expect(result).to.deep.equal({
        branch: 'feature-x',
        upstream: null,
        ahead: 0,
        behind: 0,
        hasRemote: false,
        dirty: false,
      });
    });

    it('treats any non-header line as dirty', () => {
      const output = [
        '# branch.oid abc123',
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab +0 -0',
        '1 .M N... 100644 100644 100644 abc123 def456 src/index.ts',
        '',
      ].join('\n');
      const result = parseStatusPorcelainV2(output);
      expect(result.dirty).to.equal(true);
    });

    it('reports a detached HEAD as branch: null', () => {
      const output = ['# branch.oid abc123', '# branch.head (detached)', ''].join('\n');
      const result = parseStatusPorcelainV2(output);
      expect(result.branch).to.equal(null);
    });
  });

  describe('getGitStatus()', () => {
    it('shells out to git status --porcelain=2 --branch and parses the result', async () => {
      const { stub, calls } = makeStub(() => ({
        stdout: '# branch.head main\n# branch.upstream origin/main\n# branch.ab +1 -3\n',
        stderr: '',
      }));

      const result = await getGitStatus('/tmp/ws', stub);

      expect(calls).to.deep.equal([
        ['git', ['status', '--porcelain=2', '--branch'], { cwd: '/tmp/ws', timeout: 10_000 }],
      ]);
      expect(result.branch).to.equal('main');
      expect(result.ahead).to.equal(1);
      expect(result.behind).to.equal(3);
    });
  });

  describe('listBranches()', () => {
    it('splits local vs remote branches and excludes <remote>/HEAD', async () => {
      const { stub, calls } = makeStub(() => ({
        stdout: [
          'refs/heads/main',
          'refs/heads/feature-x',
          'refs/remotes/origin/main',
          'refs/remotes/origin/feature-x',
          'refs/remotes/origin/HEAD',
          '',
        ].join('\n'),
        stderr: '',
      }));

      const result = await listBranches('/tmp/ws', stub);

      expect(calls).to.deep.equal([
        [
          'git',
          ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'],
          { cwd: '/tmp/ws', timeout: 10_000 },
        ],
      ]);
      expect(result).to.deep.equal({
        local: ['main', 'feature-x'],
        remote: ['origin/main', 'origin/feature-x'],
      });
    });
  });

  describe('fetchRemote()', () => {
    it('runs git fetch', async () => {
      const { stub, calls } = makeStub();
      await fetchRemote('/tmp/ws', stub);
      expect(calls).to.deep.equal([['git', ['fetch'], { cwd: '/tmp/ws', timeout: 60_000 }]]);
    });
  });

  describe('syncFastForward()', () => {
    it('fetches then merges --ff-only against @{u}', async () => {
      const { stub, calls } = makeStub();
      await syncFastForward('/tmp/ws', stub);
      expect(calls).to.deep.equal([
        ['git', ['fetch'], { cwd: '/tmp/ws', timeout: 60_000 }],
        ['git', ['merge', '--ff-only', '@{u}'], { cwd: '/tmp/ws', timeout: 60_000 }],
      ]);
    });

    it('propagates the merge error unmodified on a non-fast-forwardable state', async () => {
      const { stub } = makeStub((_cmd, args) => {
        if (Array.isArray(args) && args[0] === 'merge') {
          throw new Error('fatal: Not possible to fast-forward, aborting.');
        }
        return { stdout: '', stderr: '' };
      });

      let error: Error | undefined;
      try {
        await syncFastForward('/tmp/ws', stub);
      } catch (err) {
        error = err as Error;
      }
      expect(error?.message).to.equal('fatal: Not possible to fast-forward, aborting.');
    });
  });

  describe('pushBranch()', () => {
    it('runs a plain git push when an upstream is already configured', async () => {
      const { stub, calls } = makeStub();
      await pushBranch('/tmp/ws', stub);

      expect(calls).to.deep.equal([
        [
          'git',
          ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
          { cwd: '/tmp/ws', timeout: 10_000 },
        ],
        ['git', ['push'], { cwd: '/tmp/ws', timeout: 60_000 }],
      ]);
    });

    it('sets the upstream on the first push when none is configured', async () => {
      const { stub, calls } = makeStub((_cmd, args) => {
        if (Array.isArray(args) && args[0] === 'rev-parse') {
          throw new Error('fatal: no upstream configured for branch');
        }
        if (Array.isArray(args) && args[0] === 'branch') {
          return { stdout: 'feature-x\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      await pushBranch('/tmp/ws', stub);

      expect(calls).to.deep.equal([
        [
          'git',
          ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
          { cwd: '/tmp/ws', timeout: 10_000 },
        ],
        ['git', ['branch', '--show-current'], { cwd: '/tmp/ws', timeout: 10_000 }],
        ['git', ['push', '-u', 'origin', '--', 'feature-x'], { cwd: '/tmp/ws', timeout: 60_000 }],
      ]);
    });
  });

  describe('checkoutBranch()', () => {
    it('runs git checkout <branch>', async () => {
      const { stub, calls } = makeStub();
      await checkoutBranch('/tmp/ws', 'main', stub);
      expect(calls).to.deep.equal([
        ['git', ['checkout', 'main'], { cwd: '/tmp/ws', timeout: 10_000 }],
      ]);
    });

    it('rejects a branch name starting with "-" without shelling out', async () => {
      const { stub, calls } = makeStub();
      let error: Error | undefined;
      try {
        await checkoutBranch('/tmp/ws', '--upload-pack=evil', stub);
      } catch (err) {
        error = err as Error;
      }
      expect(error?.message).to.include('Invalid git ref name');
      expect(calls.length).to.equal(0);
    });
  });

  describe('createBranch()', () => {
    it('runs git checkout -b <name> with no base ref', async () => {
      const { stub, calls } = makeStub();
      await createBranch('/tmp/ws', 'feature-y', undefined, stub);
      expect(calls).to.deep.equal([
        ['git', ['checkout', '-b', 'feature-y'], { cwd: '/tmp/ws', timeout: 10_000 }],
      ]);
    });

    it('runs git checkout -b <name> <from> with a base ref', async () => {
      const { stub, calls } = makeStub();
      await createBranch('/tmp/ws', 'feature-y', 'origin/main', stub);
      expect(calls).to.deep.equal([
        [
          'git',
          ['checkout', '-b', 'feature-y', 'origin/main'],
          { cwd: '/tmp/ws', timeout: 10_000 },
        ],
      ]);
    });

    it('rejects an unsafe name or from ref without shelling out', async () => {
      const { stub, calls } = makeStub();
      let error: Error | undefined;
      try {
        await createBranch('/tmp/ws', '-x', undefined, stub);
      } catch (err) {
        error = err as Error;
      }
      expect(error?.message).to.include('Invalid git ref name');
      expect(calls.length).to.equal(0);
    });
  });

  describe('withLock()', () => {
    it('rejects an overlapping call on the same workspace id while the first is pending', async () => {
      let releaseFirst: (() => void) | undefined;
      const firstPromise = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      const firstCall = withLock('ws-1', () => firstPromise);

      let secondError: Error | undefined;
      try {
        await withLock('ws-1', async () => {});
      } catch (err) {
        secondError = err as Error;
      }
      expect(secondError).to.be.instanceOf(GitOperationInProgressError);

      releaseFirst?.();
      await firstCall;
    });

    it('releases the lock after success, allowing a subsequent call through', async () => {
      await withLock('ws-2', async () => {});
      let error: Error | undefined;
      try {
        await withLock('ws-2', async () => {});
      } catch (err) {
        error = err as Error;
      }
      expect(error).to.equal(undefined);
    });

    it('releases the lock after a rejection, allowing a subsequent call through', async () => {
      let firstError: Error | undefined;
      try {
        await withLock('ws-3', async () => {
          throw new Error('boom');
        });
      } catch (err) {
        firstError = err as Error;
      }
      expect(firstError?.message).to.equal('boom');

      let secondError: Error | undefined;
      try {
        await withLock('ws-3', async () => {});
      } catch (err) {
        secondError = err as Error;
      }
      expect(secondError).to.equal(undefined);
    });

    it('does not affect the lock for a different workspace id', async () => {
      let releaseFirst: (() => void) | undefined;
      const firstPromise = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstCall = withLock('ws-4', () => firstPromise);

      let error: Error | undefined;
      try {
        await withLock('ws-5', async () => {});
      } catch (err) {
        error = err as Error;
      }
      expect(error).to.equal(undefined);

      releaseFirst?.();
      await firstCall;
    });
  });
});
