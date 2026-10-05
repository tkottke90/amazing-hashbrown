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
  translateGitAuthError,
  type GitStatus,
} from './workspace-git.js';
import type { ExecFileFn } from './workspace-provision.js';

const GIT_AUTH_ERROR =
  "fatal: could not read Username for 'https://github.com': No such device or address";

function decodeBasicHeader(authArg: string): string {
  const basic = authArg.split('Basic ')[1]!;
  return Buffer.from(basic, 'base64').toString('utf8');
}

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

    it('omits auth args when no token is passed, unchanged from today', async () => {
      const { stub, calls } = makeStub();
      await fetchRemote('/tmp/ws', stub, undefined);
      expect(calls).to.deep.equal([['git', ['fetch'], { cwd: '/tmp/ws', timeout: 60_000 }]]);
    });

    it('prepends a -c extraHeader arg when a token is passed explicitly', async () => {
      const { stub, calls } = makeStub();
      await fetchRemote('/tmp/ws', stub, 'ghp_x');
      const [cmd, args, opts] = calls[0] as [string, string[], unknown];
      expect(cmd).to.equal('git');
      expect(args.slice(2)).to.deep.equal(['fetch']);
      expect(args[0]).to.equal('-c');
      expect(decodeBasicHeader(args[1]!)).to.equal('x-access-token:ghp_x');
      expect(opts).to.deep.equal({ cwd: '/tmp/ws', timeout: 60_000 });
    });

    it('translates the git auth error instead of surfacing it raw', async () => {
      const { stub } = makeStub(() => {
        throw new Error(`Command failed: git fetch\n${GIT_AUTH_ERROR}`);
      });

      let error: Error | undefined;
      try {
        await fetchRemote('/tmp/ws', stub);
      } catch (err) {
        error = err as Error;
      }
      expect(error?.message).to.include('Git fetch failed');
      expect(error?.message).to.include('Settings → Workspaces → Git');
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

    it('puts auth args on the fetch leg only — the local merge needs none', async () => {
      const { stub, calls } = makeStub();
      await syncFastForward('/tmp/ws', stub, 'ghp_x');
      expect(calls).to.have.length(2);
      const [, fetchArgs] = calls[0] as [string, string[], unknown];
      expect(fetchArgs[0]).to.equal('-c');
      expect(calls[1]).to.deep.equal([
        'git',
        ['merge', '--ff-only', '@{u}'],
        { cwd: '/tmp/ws', timeout: 60_000 },
      ]);
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

    it('prepends auth args to a plain push when a token is passed', async () => {
      const { stub, calls } = makeStub();
      await pushBranch('/tmp/ws', stub, 'ghp_x');

      const pushCall = calls[1] as [string, string[], unknown];
      expect(pushCall[1][0]).to.equal('-c');
      expect(decodeBasicHeader(pushCall[1][1] as string)).to.equal('x-access-token:ghp_x');
      expect(pushCall[1].slice(2)).to.deep.equal(['push']);
      // The upstream probe itself carries no auth args — it's a local read.
      expect((calls[0] as [string, string[], unknown])[1]).to.deep.equal([
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        '@{u}',
      ]);
    });

    it('prepends auth args to the first-push -u branch when a token is passed', async () => {
      const { stub, calls } = makeStub((_cmd, args) => {
        if (Array.isArray(args) && args.includes('rev-parse')) {
          throw new Error('fatal: no upstream configured for branch');
        }
        if (Array.isArray(args) && args.includes('branch')) {
          return { stdout: 'feature-x\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });

      await pushBranch('/tmp/ws', stub, 'ghp_x');

      const pushCall = calls[2] as [string, string[], unknown];
      expect(decodeBasicHeader(pushCall[1][1] as string)).to.equal('x-access-token:ghp_x');
      expect(pushCall[1].slice(2)).to.deep.equal(['push', '-u', 'origin', '--', 'feature-x']);
    });

    it('translates the git auth error instead of surfacing it raw', async () => {
      const { stub } = makeStub((_cmd, args) => {
        if (Array.isArray(args) && args.includes('push')) {
          throw new Error(`Command failed: git push\n${GIT_AUTH_ERROR}`);
        }
        return { stdout: '', stderr: '' };
      });

      let error: Error | undefined;
      try {
        await pushBranch('/tmp/ws', stub);
      } catch (err) {
        error = err as Error;
      }
      expect(error?.message).to.include('Git push failed');
      expect(error?.message).to.include('Settings → Workspaces → Git');
    });
  });

  describe('translateGitAuthError()', () => {
    it('rewrites the "could not read Username" error with the operation verb', () => {
      const message = translateGitAuthError(GIT_AUTH_ERROR, 'push');
      expect(message).to.include('Git push failed');
      expect(message).to.include('Settings → Workspaces → Git');
    });

    it('matches even when execFile wraps the git stderr in a larger message', () => {
      const wrapped = `Command failed: git fetch\n${GIT_AUTH_ERROR}\n`;
      const message = translateGitAuthError(wrapped, 'fetch');
      expect(message).to.include('Git fetch failed');
    });

    it('passes through an unrelated error unchanged', () => {
      const original = 'fatal: Not possible to fast-forward, aborting.';
      expect(translateGitAuthError(original, 'push')).to.equal(original);
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
