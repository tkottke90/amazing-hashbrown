import { mkdtempSync, mkdirSync, rmSync, existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import {
  isLocationRoot,
  resolvePathUnderRoot,
  resolveFilePathUnderWorkspace,
  createWorkspaceDirectory,
  DirectoryExistsError,
  isManagedLocation,
  removeWorkspaceDirectory,
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

    it('throws a DirectoryExistsError naming the path when the directory already exists [unit]', async () => {
      const target = join(dir, 'existing-workspace');
      await createWorkspaceDirectory(target);
      let error: unknown;
      try {
        await createWorkspaceDirectory(target);
      } catch (err) {
        error = err;
      }
      expect(error, 'a leaf collision must be a typed error').to.be.instanceOf(
        DirectoryExistsError,
      );
      expect((error as DirectoryExistsError).path).to.equal(target);
      expect(
        (error as Error).message,
        'the user needs the path to find the leftover directory',
      ).to.include(target);
    });
  });

  describe('isManagedLocation()', () => {
    const projects = '/data/projects';
    const temp = '/tmp/projects';

    it('accepts a direct child of either root [unit]', () => {
      expect(isManagedLocation('/data/projects/foo', [projects, temp])).to.equal(true);
      expect(isManagedLocation('/tmp/projects/bar', [projects, temp])).to.equal(true);
    });

    it('rejects the root itself, so a bad location can never wipe every project [unit]', () => {
      expect(isManagedLocation('/data/projects', [projects])).to.equal(false);
      expect(isManagedLocation('/data/projects/', [projects])).to.equal(false);
    });

    it('rejects a nested path below a direct child [unit]', () => {
      expect(isManagedLocation('/data/projects/foo/bar', [projects])).to.equal(false);
    });

    it('rejects a sibling directory that only shares a string prefix with the root [unit]', () => {
      expect(isManagedLocation('/data/projects-old/foo', [projects])).to.equal(false);
    });

    it('rejects a path that escapes the root via ".." [unit]', () => {
      expect(isManagedLocation('/data/projects/../elsewhere', [projects])).to.equal(false);
      expect(isManagedLocation('/data/projects/foo/../../etc', [projects])).to.equal(false);
    });

    it('rejects an unrelated absolute path such as a legacy free-form location [unit]', () => {
      expect(isManagedLocation('/home/user/code/my-repo', [projects, temp])).to.equal(false);
    });

    it('rejects an empty location [unit]', () => {
      expect(isManagedLocation('', [projects])).to.equal(false);
    });

    it('resolves relative roots against the working directory [unit]', () => {
      expect(isManagedLocation(join(process.cwd(), 'projects', 'foo'), ['./projects'])).to.equal(
        true,
      );
    });
  });

  describe('removeWorkspaceDirectory()', () => {
    let dir: string;
    let root: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspace-remove-test-'));
      root = join(dir, 'root');
      mkdirSync(root);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('removes a managed directory and its contents [unit]', async () => {
      const location = join(root, 'ws');
      mkdirSync(join(location, 'nested'), { recursive: true });
      writeFileSync(join(location, 'nested', 'file.txt'), 'data');

      const result = await removeWorkspaceDirectory(location, [root]);

      expect(result).to.deep.equal({ removed: true, path: location });
      expect(existsSync(location), 'managed directory should be gone').to.equal(false);
    });

    it('refuses to touch a directory outside the managed roots [unit]', async () => {
      const location = join(dir, 'elsewhere', 'ws');
      mkdirSync(location, { recursive: true });
      writeFileSync(join(location, 'keep.txt'), 'data');

      const result = await removeWorkspaceDirectory(location, [root]);

      expect(result).to.deep.equal({
        removed: false,
        path: location,
        reason: 'outside-managed-roots',
      });
      expect(
        existsSync(join(location, 'keep.txt')),
        'unmanaged files must survive a workspace delete',
      ).to.equal(true);
    });

    it('treats an already-missing managed directory as removed [unit]', async () => {
      const location = join(root, 'never-created');
      const result = await removeWorkspaceDirectory(location, [root]);
      expect(result).to.deep.equal({ removed: true, path: location });
    });

    it('removes a symlinked location without following it to the target [unit]', async () => {
      const target = join(dir, 'real-target');
      mkdirSync(target);
      writeFileSync(join(target, 'precious.txt'), 'data');
      const location = join(root, 'link');
      symlinkSync(target, location, 'dir');

      const result = await removeWorkspaceDirectory(location, [root]);

      expect(result.removed).to.equal(true);
      expect(existsSync(location), 'the symlink itself should be removed').to.equal(false);
      expect(
        existsSync(join(target, 'precious.txt')),
        'the symlink target and its files must be left intact',
      ).to.equal(true);
    });
  });
});
