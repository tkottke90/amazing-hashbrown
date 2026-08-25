import { describe, it } from 'mocha';
import { expect } from 'chai';
import { provisionDependencyIsolation, type ExecFileFn } from './workspace-provision.js';

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
});
