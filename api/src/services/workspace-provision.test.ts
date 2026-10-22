import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
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

    it('omits auth args when no token is passed, unchanged from today', async () => {
      const { stub, calls } = makeStub();
      await provisionGitRepository(
        '/tmp/ws',
        { git: true, remoteUrl: 'https://example.com/org/repo.git' },
        stub,
        undefined,
      );
      expect(calls).to.deep.equal([
        [
          'git',
          ['clone', '--', 'https://example.com/org/repo.git', '.'],
          { cwd: '/tmp/ws', timeout: 60_000 },
        ],
      ]);
    });

    it('prepends a -c extraHeader arg to the clone when a token is passed', async () => {
      const { stub, calls } = makeStub();
      await provisionGitRepository(
        '/tmp/ws',
        { git: true, remoteUrl: 'https://example.com/org/repo.git' },
        stub,
        'ghp_x',
      );
      const [cmd, args, opts] = calls[0] as [string, string[], unknown];
      expect(cmd).to.equal('git');
      expect(args[0]).to.equal('-c');
      expect(args.slice(2)).to.deep.equal(['clone', '--', 'https://example.com/org/repo.git', '.']);
      expect(opts).to.deep.equal({ cwd: '/tmp/ws', timeout: 60_000 });
    });

    it('translates a clone auth error instead of surfacing it raw', async () => {
      const { stub } = makeStub(() => {
        throw new Error(
          "Command failed: git clone\nfatal: could not read Username for 'https://github.com': No such device or address",
        );
      });
      let error: Error | undefined;
      try {
        await provisionGitRepository(
          '/tmp/ws',
          { git: true, remoteUrl: 'https://example.com/org/repo.git' },
          stub,
        );
      } catch (err) {
        error = err as Error;
      }
      expect(error?.message).to.include('Git clone failed');
      expect(error?.message).to.include('Settings → Workspaces → Git');
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

  describe('provisionGitRepository() — .hashbrown/ gitignore (ADR-0040)', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspace-provision-gitignore-test-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('creates a fresh .gitignore covering .hashbrown/ after git init, when none existed', async () => {
      const { stub } = makeStub();
      await provisionGitRepository(dir, { git: true }, stub);

      expect(readFileSync(join(dir, '.gitignore'), 'utf8')).to.equal('.hashbrown/\n');
    });

    it('appends a .hashbrown/ line to an existing .gitignore that does not already cover it', async () => {
      writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
      const { stub } = makeStub();

      await provisionGitRepository(dir, { git: true }, stub);

      expect(readFileSync(join(dir, '.gitignore'), 'utf8')).to.equal(
        'node_modules/\n.hashbrown/\n',
      );
    });

    it('adds a newline before appending when the existing file does not end in one', async () => {
      writeFileSync(join(dir, '.gitignore'), 'node_modules/');
      const { stub } = makeStub();

      await provisionGitRepository(dir, { git: true }, stub);

      expect(readFileSync(join(dir, '.gitignore'), 'utf8')).to.equal(
        'node_modules/\n.hashbrown/\n',
      );
    });

    it('leaves a .gitignore that already covers .hashbrown/ byte-for-byte unchanged (idempotent)', async () => {
      const original = 'node_modules/\n.hashbrown/\n';
      writeFileSync(join(dir, '.gitignore'), original);
      const { stub } = makeStub();

      await provisionGitRepository(dir, { git: true }, stub);

      expect(readFileSync(join(dir, '.gitignore'), 'utf8')).to.equal(original);
    });

    it('also recognizes a bare ".hashbrown" (no trailing slash) as already covering it', async () => {
      const original = '.hashbrown\n';
      writeFileSync(join(dir, '.gitignore'), original);
      const { stub } = makeStub();

      await provisionGitRepository(dir, { git: true }, stub);

      expect(readFileSync(join(dir, '.gitignore'), 'utf8')).to.equal(original);
    });

    it('does nothing when git is false', async () => {
      const { stub } = makeStub();
      await provisionGitRepository(dir, { git: false }, stub);

      const { existsSync } = await import('node:fs');
      expect(existsSync(join(dir, '.gitignore'))).to.equal(false);
    });

    it('also runs after a clone (remoteUrl set), not just git init', async () => {
      const { stub } = makeStub();
      await provisionGitRepository(
        dir,
        { git: true, remoteUrl: 'https://example.com/org/repo.git' },
        stub,
      );

      expect(readFileSync(join(dir, '.gitignore'), 'utf8')).to.equal('.hashbrown/\n');
    });
  });
});
