import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import {
  isLocationRoot,
  resolvePathUnderRoot,
  resolveFilePathUnderWorkspace,
  createWorkspaceDirectory,
} from './workspace-location.js';

describe('services/workspace-location', () => {
  describe('isLocationRoot()', () => {
    it('accepts "projects" and "temporary"', () => {
      expect(isLocationRoot('projects')).to.equal(true);
      expect(isLocationRoot('temporary')).to.equal(true);
    });

    it('rejects any other value', () => {
      expect(isLocationRoot('other')).to.equal(false);
      expect(isLocationRoot(undefined)).to.equal(false);
      expect(isLocationRoot(null)).to.equal(false);
      expect(isLocationRoot(42)).to.equal(false);
    });
  });

  describe('resolvePathUnderRoot()', () => {
    const base = '/tmp/some-root';

    it('resolves a plain name to a direct child of the base path', () => {
      expect(resolvePathUnderRoot(base, 'my-workspace')).to.equal('/tmp/some-root/my-workspace');
    });

    it('trims surrounding whitespace', () => {
      expect(resolvePathUnderRoot(base, '  my-workspace  ')).to.equal(
        '/tmp/some-root/my-workspace',
      );
    });

    it('throws on an empty or whitespace-only name', () => {
      expect(() => resolvePathUnderRoot(base, '')).to.throw('directoryName is required');
      expect(() => resolvePathUnderRoot(base, '   ')).to.throw('directoryName is required');
    });

    it('throws on "." and ".."', () => {
      expect(() => resolvePathUnderRoot(base, '.')).to.throw('Invalid directoryName');
      expect(() => resolvePathUnderRoot(base, '..')).to.throw('Invalid directoryName');
    });

    it('throws on a traversal attempt with an embedded separator', () => {
      expect(() => resolvePathUnderRoot(base, '../../etc')).to.throw('Invalid directoryName');
      expect(() => resolvePathUnderRoot(base, 'foo/../../etc')).to.throw('Invalid directoryName');
      expect(() => resolvePathUnderRoot(base, 'a/b')).to.throw('Invalid directoryName');
    });

    it('throws on an absolute path injection', () => {
      expect(() => resolvePathUnderRoot(base, '/etc/passwd')).to.throw('Invalid directoryName');
    });

    it('throws on a null byte', () => {
      expect(() => resolvePathUnderRoot(base, 'foo\0bar')).to.throw('Invalid directoryName');
    });
  });

  describe('resolveFilePathUnderWorkspace()', () => {
    const base = '/tmp/some-workspace';

    it('resolves a nested multi-segment path correctly', () => {
      expect(resolveFilePathUnderWorkspace(base, 'scripts/checksum-verify.py')).to.equal(
        '/tmp/some-workspace/scripts/checksum-verify.py',
      );
    });

    it('resolves a single-segment path (parity with resolvePathUnderRoot)', () => {
      expect(resolveFilePathUnderWorkspace(base, 'README.md')).to.equal(
        '/tmp/some-workspace/README.md',
      );
    });

    it('throws on a "../../etc/passwd" traversal attempt', () => {
      expect(() => resolveFilePathUnderWorkspace(base, '../../etc/passwd')).to.throw(
        'Invalid file path',
      );
    });

    it('throws on an absolute-path injection', () => {
      expect(() => resolveFilePathUnderWorkspace(base, '/etc/passwd')).to.throw(
        'Invalid file path',
      );
    });

    it('throws on a null byte', () => {
      expect(() => resolveFilePathUnderWorkspace(base, 'foo\0bar')).to.throw('Invalid file path');
    });

    it('throws on an empty path', () => {
      expect(() => resolveFilePathUnderWorkspace(base, '')).to.throw('Invalid file path');
    });
  });

  describe('createWorkspaceDirectory()', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspace-location-test-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('creates the directory', async () => {
      const target = join(dir, 'new-workspace');
      await createWorkspaceDirectory(target);
      expect(existsSync(target)).to.equal(true);
    });

    it('throws a friendly error when the directory already exists', async () => {
      const target = join(dir, 'existing-workspace');
      await createWorkspaceDirectory(target);
      let error: Error | undefined;
      try {
        await createWorkspaceDirectory(target);
      } catch (err) {
        error = err as Error;
      }
      expect(error?.message).to.equal(
        'A directory already exists at this location — choose a different name',
      );
    });
  });
});
