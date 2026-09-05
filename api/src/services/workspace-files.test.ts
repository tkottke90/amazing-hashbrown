import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import type { ExecFileFn } from './workspace-provision.js';
import {
  buildFileTree,
  parsePorcelain,
  getGitOverlay,
  getFileTree,
  invalidateFileTreeCache,
  readFileGuarded,
  isContentTooLarge,
  classifyFile,
  getContentType,
} from './workspace-files.js';

function makeExecStub(impl?: (...args: Parameters<ExecFileFn>) => unknown) {
  const calls: unknown[][] = [];
  const stub = (async (...args: Parameters<ExecFileFn>) => {
    calls.push(args);
    if (impl) return impl(...args);
    return { stdout: '', stderr: '' };
  }) as unknown as ExecFileFn;
  return { stub, calls };
}

describe('services/workspace-files', () => {
  describe('buildFileTree()', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspace-files-test-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('excludes .git/node_modules/.venv at any depth', async () => {
      mkdirSync(join(dir, '.git'));
      writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      mkdirSync(join(dir, 'node_modules'));
      writeFileSync(join(dir, 'node_modules', 'pkg.json'), '{}');
      mkdirSync(join(dir, '.venv'));
      writeFileSync(join(dir, '.venv', 'pyvenv.cfg'), '');
      mkdirSync(join(dir, 'sub'));
      mkdirSync(join(dir, 'sub', 'node_modules'));
      writeFileSync(join(dir, 'sub', 'node_modules', 'x.js'), '');
      writeFileSync(join(dir, 'README.md'), '# hi\n');

      const tree = await buildFileTree(dir);
      const names = tree.map((n) => n.name).sort();
      expect(names).to.deep.equal(['README.md', 'sub']);

      const sub = tree.find((n) => n.name === 'sub')!;
      expect(sub.children).to.deep.equal([]);
    });

    it('walks nested directories and sorts dirs before files, alphabetically', async () => {
      mkdirSync(join(dir, 'b-dir'));
      mkdirSync(join(dir, 'a-dir'));
      writeFileSync(join(dir, 'b-dir', 'inner.txt'), 'x');
      writeFileSync(join(dir, 'z.txt'), 'z');
      writeFileSync(join(dir, 'a.txt'), 'a');

      const tree = await buildFileTree(dir);
      expect(tree.map((n) => ({ name: n.name, type: n.type }))).to.deep.equal([
        { name: 'a-dir', type: 'dir' },
        { name: 'b-dir', type: 'dir' },
        { name: 'a.txt', type: 'file' },
        { name: 'z.txt', type: 'file' },
      ]);

      const bDir = tree.find((n) => n.name === 'b-dir')!;
      expect(bDir.children).to.deep.equal([
        { name: 'inner.txt', path: 'b-dir/inner.txt', type: 'file', category: 'text', oversize: false },
      ]);
    });

    it('sets category/oversize on file nodes based on extension and size', async () => {
      writeFileSync(join(dir, 'photo.png'), 'fake-png-bytes');
      writeFileSync(join(dir, 'song.mp3'), 'fake-mp3-bytes');
      writeFileSync(join(dir, 'clip.mp4'), 'fake-mp4-bytes');
      writeFileSync(join(dir, 'archive.zip'), 'fake-zip-bytes');
      writeFileSync(join(dir, 'notes.txt'), 'plain text');
      writeFileSync(join(dir, 'huge.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 'a'));

      const tree = await buildFileTree(dir);
      const byName = new Map(tree.map((n) => [n.name, n]));

      expect(byName.get('photo.png')).to.include({ category: 'image', oversize: false });
      expect(byName.get('song.mp3')).to.include({ category: 'audio', oversize: false });
      expect(byName.get('clip.mp4')).to.include({ category: 'video', oversize: false });
      expect(byName.get('archive.zip')).to.include({ category: 'unsupported', oversize: false });
      expect(byName.get('notes.txt')).to.include({ category: 'text', oversize: false });
      expect(byName.get('huge.txt')).to.include({ category: 'text', oversize: true });
    });

    it('returns an empty array for an empty directory', async () => {
      const tree = await buildFileTree(dir);
      expect(tree).to.deep.equal([]);
    });

    it('skips symlinks', async () => {
      writeFileSync(join(dir, 'real.txt'), 'x');
      symlinkSync(join(dir, 'real.txt'), join(dir, 'link.txt'));

      const tree = await buildFileTree(dir);
      expect(tree.map((n) => n.name)).to.deep.equal(['real.txt']);
    });

    it('throws for a non-existent root', async () => {
      let error: Error | undefined;
      try {
        await buildFileTree(join(dir, 'does-not-exist'));
      } catch (err) {
        error = err as Error;
      }
      expect(error).to.not.equal(undefined);
    });
  });

  describe('classifyFile()', () => {
    it('classifies known image extensions', () => {
      expect(classifyFile('photo.png')).to.equal('image');
      expect(classifyFile('photo.jpg')).to.equal('image');
      expect(classifyFile('photo.svg')).to.equal('image');
    });

    it('classifies known audio extensions', () => {
      expect(classifyFile('song.mp3')).to.equal('audio');
      expect(classifyFile('song.flac')).to.equal('audio');
    });

    it('classifies known video extensions', () => {
      expect(classifyFile('clip.mp4')).to.equal('video');
      expect(classifyFile('clip.webm')).to.equal('video');
    });

    it('classifies known-unsupported extensions', () => {
      expect(classifyFile('archive.zip')).to.equal('unsupported');
      expect(classifyFile('doc.pdf')).to.equal('unsupported');
      expect(classifyFile('lib.so')).to.equal('unsupported');
    });

    it('defaults to text for an unknown extension', () => {
      expect(classifyFile('main.rs')).to.equal('text');
    });

    it('defaults to text for a file with no extension', () => {
      expect(classifyFile('Makefile')).to.equal('text');
    });

    it('is case-insensitive', () => {
      expect(classifyFile('IMAGE.PNG')).to.equal('image');
    });
  });

  describe('getContentType()', () => {
    it('returns the mime type for a known image/audio/video extension', () => {
      expect(getContentType('photo.png')).to.equal('image/png');
      expect(getContentType('song.mp3')).to.equal('audio/mpeg');
      expect(getContentType('clip.mp4')).to.equal('video/mp4');
    });

    it('falls back to application/octet-stream for an unmapped extension', () => {
      expect(getContentType('archive.zip')).to.equal('application/octet-stream');
    });
  });

  describe('parsePorcelain()', () => {
    it('maps untracked files ("??") to A', () => {
      const statuses = parsePorcelain('?? new-file.txt\n');
      expect(statuses.get('new-file.txt')).to.equal('A');
    });

    it('maps a staged add to A', () => {
      const statuses = parsePorcelain('A  staged-new.txt\n');
      expect(statuses.get('staged-new.txt')).to.equal('A');
    });

    it('maps an unstaged modification to M', () => {
      const statuses = parsePorcelain(' M modified.txt\n');
      expect(statuses.get('modified.txt')).to.equal('M');
    });

    it('maps a staged modification to M', () => {
      const statuses = parsePorcelain('M  modified.txt\n');
      expect(statuses.get('modified.txt')).to.equal('M');
    });

    it('maps a rename to A, keyed under the new path', () => {
      const statuses = parsePorcelain('R  old-name.txt -> new-name.txt\n');
      expect(statuses.has('old-name.txt')).to.equal(false);
      expect(statuses.get('new-name.txt')).to.equal('A');
    });

    it('parses multiple lines independently', () => {
      const statuses = parsePorcelain('?? untracked.txt\n M modified.txt\nA  staged.txt\n');
      expect(statuses.size).to.equal(3);
      expect(statuses.get('untracked.txt')).to.equal('A');
      expect(statuses.get('modified.txt')).to.equal('M');
      expect(statuses.get('staged.txt')).to.equal('A');
    });
  });

  describe('getGitOverlay()', () => {
    it('shells out to git branch --show-current and git status --porcelain with the workspace cwd', async () => {
      let call = 0;
      const calls: unknown[][] = [];
      const stub = (async (...args: Parameters<ExecFileFn>) => {
        calls.push(args);
        call++;
        if (call === 1) return { stdout: 'main\n', stderr: '' };
        return { stdout: '?? untracked.txt\n', stderr: '' };
      }) as unknown as ExecFileFn;

      const overlay = await getGitOverlay('/tmp/some-workspace', stub);
      expect(overlay.branch).to.equal('main');
      expect(overlay.statuses.get('untracked.txt')).to.equal('A');
      expect(calls).to.deep.equal([
        ['git', ['branch', '--show-current'], { cwd: '/tmp/some-workspace', timeout: 10_000 }],
        ['git', ['status', '--porcelain'], { cwd: '/tmp/some-workspace', timeout: 10_000 }],
      ]);
    });

    it('reports a null branch when show-current returns empty output', async () => {
      const { stub } = makeExecStub(() => ({ stdout: '\n', stderr: '' }));
      const overlay = await getGitOverlay('/tmp/some-workspace', stub);
      expect(overlay.branch).to.equal(null);
    });
  });

  describe('getFileTree() / invalidateFileTreeCache()', () => {
    let dir: string;
    const workspaceId = 'ws-cache-test';
    let originalDateNow: () => number;
    let currentTime: number;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspace-files-cache-test-'));
      writeFileSync(join(dir, 'a.txt'), 'a');
      invalidateFileTreeCache(workspaceId);
      currentTime = Date.now();
      originalDateNow = Date.now;
      // Hand-rolled clock stub (no sinon in this repo's toolchain), same
      // monkey-patch-and-restore style already used for timers in
      // task-scheduler.test.ts.
      Date.now = () => currentTime;
    });

    afterEach(() => {
      Date.now = originalDateNow;
      invalidateFileTreeCache(workspaceId);
      rmSync(dir, { recursive: true, force: true });
    });

    it('serves a cached result within the TTL window without re-shelling-out to git', async () => {
      const { stub, calls } = makeExecStub();
      await getFileTree(workspaceId, { location: dir, git: true }, stub);
      expect(calls.length).to.equal(2);

      await getFileTree(workspaceId, { location: dir, git: true }, stub);
      expect(calls.length).to.equal(2); // still 2 — served from cache, no re-shell-out
    });

    it('invalidateFileTreeCache forces a re-walk on the next call', async () => {
      const { stub, calls } = makeExecStub();
      await getFileTree(workspaceId, { location: dir, git: true }, stub);
      expect(calls.length).to.equal(2);

      invalidateFileTreeCache(workspaceId);
      await getFileTree(workspaceId, { location: dir, git: true }, stub);
      expect(calls.length).to.equal(4);
    });

    it('re-walks once the TTL has elapsed', async () => {
      const { stub, calls } = makeExecStub();
      await getFileTree(workspaceId, { location: dir, git: true }, stub);
      expect(calls.length).to.equal(2);

      currentTime += 16_000; // beyond the 15s TTL
      await getFileTree(workspaceId, { location: dir, git: true }, stub);
      expect(calls.length).to.equal(4);
    });

    it('attaches a content URL to every file node, including nested/special-character paths', async () => {
      mkdirSync(join(dir, 'sub dir'));
      writeFileSync(join(dir, 'sub dir', 'a b.txt'), 'x');

      const tree = await getFileTree(workspaceId, { location: dir, git: false });
      expect(tree.entries.find((n) => n.name === 'a.txt')!.content).to.equal(
        `/api/v1/workspaces/${workspaceId}/files/a.txt/content`,
      );

      const subDir = tree.entries.find((n) => n.name === 'sub dir')!;
      expect(subDir.children!.find((n) => n.name === 'a b.txt')!.content).to.equal(
        `/api/v1/workspaces/${workspaceId}/files/sub%20dir/a%20b.txt/content`,
      );
    });

    it('does not shell out to git at all when workspace.git is false', async () => {
      const { stub, calls } = makeExecStub();
      const tree = await getFileTree(workspaceId, { location: dir, git: false }, stub);
      expect(calls.length).to.equal(0);
      expect(tree.branch).to.equal(null);
      expect(tree.entries.every((n) => n.gitStatus === undefined)).to.equal(true);
    });
  });

  describe('readFileGuarded()', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'workspace-files-read-test-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('reads a normal text file', async () => {
      const p = join(dir, 'hello.txt');
      writeFileSync(p, 'hello world\n');
      const result = await readFileGuarded(p);
      expect(result).to.deep.equal({ ok: true, content: 'hello world\n' });
    });

    it('rejects a file over the 2MB size cap', async () => {
      const p = join(dir, 'big.txt');
      writeFileSync(p, Buffer.alloc(2 * 1024 * 1024 + 1, 'a'));
      const result = await readFileGuarded(p);
      expect(result).to.deep.equal({ ok: false, reason: 'too-large' });
    });

    it('rejects a file with a null byte in the first 8KB', async () => {
      const p = join(dir, 'binary.bin');
      writeFileSync(p, Buffer.from([0x41, 0x42, 0x00, 0x43]));
      const result = await readFileGuarded(p);
      expect(result).to.deep.equal({ ok: false, reason: 'binary' });
    });

    it('rejects a file with invalid UTF-8', async () => {
      const p = join(dir, 'invalid-utf8.bin');
      writeFileSync(p, Buffer.from([0xff, 0xfe, 0xfd]));
      const result = await readFileGuarded(p);
      expect(result).to.deep.equal({ ok: false, reason: 'binary' });
    });
  });

  describe('isContentTooLarge()', () => {
    it('returns false for content well under the cap', () => {
      expect(isContentTooLarge('hello')).to.equal(false);
    });

    it('measures byte length, not JS string .length, for multi-byte characters', () => {
      // Each '€' is 1 UTF-16 code unit (string .length) but 3 UTF-8 bytes —
      // so a string whose .length is well under 2MB can still be over the
      // cap in actual bytes.
      const charsNeeded = Math.ceil((2 * 1024 * 1024 + 1) / 3);
      const content = '€'.repeat(charsNeeded);
      expect(content.length).to.be.lessThan(2 * 1024 * 1024 + 1);
      expect(isContentTooLarge(content)).to.equal(true);
    });
  });
});
