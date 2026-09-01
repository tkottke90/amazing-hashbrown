import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
  provisionDependencyIsolation,
  provisionGitRepository,
  type ExecFileFn,
} from './workspace-provision.js';

function makeStub(impl?: (...args: Parameters<ExecFileFn>) => unknown) {
  const calls: unknown[][] = [];
  const stub = (async (...args: Parameters<ExecFileFn>) => {
    calls.push(args);
    if (impl) return impl(...args);
    return { stdout: '', stderr: '' };
  }) as unknown as ExecFileFn;
  return { stub, calls };
}

describe('services/workspace-provision', () => {
  describe('provisionDependencyIsolation()', () => {
    it('calls nothing when neither flag is set', async () => {
      const { stub, calls } = makeStub();
      await provisionDependencyIsolation('/tmp/ws', { javascript: false, python: false }, stub);
      expect(calls.length).to.equal(0);
    });

    it('runs npm init -y when javascript is set', async () => {
      const { stub, calls } = makeStub();
      await provisionDependencyIsolation('/tmp/ws', { javascript: true, python: false }, stub);
      expect(calls).to.deep.equal([['npm', ['init', '-y'], { cwd: '/tmp/ws', timeout: 30_000 }]]);
    });

    it('runs python3 -m venv .venv when python is set', async () => {
      const { stub, calls } = makeStub();
      await provisionDependencyIsolation('/tmp/ws', { javascript: false, python: true }, stub);
      expect(calls).to.deep.equal([
        ['python3', ['-m', 'venv', '.venv'], { cwd: '/tmp/ws', timeout: 30_000 }],
      ]);
    });

    it('runs javascript before python when both are set', async () => {
      const { stub, calls } = makeStub();
      await provisionDependencyIsolation('/tmp/ws', { javascript: true, python: true }, stub);
      expect(calls).to.deep.equal([
        ['npm', ['init', '-y'], { cwd: '/tmp/ws', timeout: 30_000 }],
        ['python3', ['-m', 'venv', '.venv'], { cwd: '/tmp/ws', timeout: 30_000 }],
      ]);
    });

    it('propagates a rejection and does not run the second command', async () => {
      const { stub, calls } = makeStub(() => {
        throw new Error('npm not found');
      });
      let error: Error | undefined;
      try {
        await provisionDependencyIsolation('/tmp/ws', { javascript: true, python: true }, stub);
      } catch (err) {
        error = err as Error;
      }
      expect(error?.message).to.equal('npm not found');
      expect(calls.length).to.equal(1);
    });
  });

  describe('provisionGitRepository()', () => {
    it('calls nothing when git is false', async () => {
      const { stub, calls } = makeStub();
      await provisionGitRepository('/tmp/ws', { git: false }, stub);
      expect(calls.length).to.equal(0);
    });

    it('calls nothing when git is false even with a remoteUrl set', async () => {
      const { stub, calls } = makeStub();
      await provisionGitRepository(
        '/tmp/ws',
        { git: false, remoteUrl: 'https://example.com/org/repo.git' },
        stub,
      );
      expect(calls.length).to.equal(0);
    });

    it('runs git init when git is true and no remoteUrl is given', async () => {
      const { stub, calls } = makeStub();
      await provisionGitRepository('/tmp/ws', { git: true }, stub);
      expect(calls).to.deep.equal([['git', ['init'], { cwd: '/tmp/ws', timeout: 10_000 }]]);
    });

    it('runs git init when git is true and remoteUrl is an empty/whitespace string', async () => {
      const { stub, calls } = makeStub();
      await provisionGitRepository('/tmp/ws', { git: true, remoteUrl: '   ' }, stub);
      expect(calls).to.deep.equal([['git', ['init'], { cwd: '/tmp/ws', timeout: 10_000 }]]);
    });

    it('runs git clone -- <url> . when git is true and remoteUrl is set', async () => {
      const { stub, calls } = makeStub();
      await provisionGitRepository(
        '/tmp/ws',
        { git: true, remoteUrl: 'https://example.com/org/repo.git' },
        stub,
      );
      expect(calls).to.deep.equal([
        [
          'git',
          ['clone', '--', 'https://example.com/org/repo.git', '.'],
          { cwd: '/tmp/ws', timeout: 60_000 },
        ],
      ]);
    });

    it('trims the remoteUrl before cloning', async () => {
      const { stub, calls } = makeStub();
      await provisionGitRepository(
        '/tmp/ws',
        { git: true, remoteUrl: '  https://example.com/org/repo.git  ' },
        stub,
      );
      expect(calls).to.deep.equal([
        [
          'git',
          ['clone', '--', 'https://example.com/org/repo.git', '.'],
          { cwd: '/tmp/ws', timeout: 60_000 },
        ],
      ]);
    });

    it('propagates a clone rejection', async () => {
      const { stub } = makeStub(() => {
        throw new Error('Repository not found');
      });
      let error: Error | undefined;
      try {
        await provisionGitRepository(
          '/tmp/ws',
          { git: true, remoteUrl: 'https://example.com/org/nope.git' },
          stub,
        );
      } catch (err) {
        error = err as Error;
      }
      expect(error?.message).to.equal('Repository not found');
    });

    it('propagates an init rejection', async () => {
      const { stub } = makeStub(() => {
        throw new Error('git not found');
      });
      let error: Error | undefined;
      try {
        await provisionGitRepository('/tmp/ws', { git: true }, stub);
      } catch (err) {
        error = err as Error;
      }
      expect(error?.message).to.equal('git not found');
    });
  });
});
