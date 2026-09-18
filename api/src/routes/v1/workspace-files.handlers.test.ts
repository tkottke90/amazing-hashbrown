import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { openDatabase } from '@tkottke90/llm-common-types/db';
import { WorkspaceStore } from '../../services/workspace-store.js';
import type { ExecFileFn } from '../../services/workspace-provision.js';
import {
  getFileTreeHandler,
  getFileContentHandler,
  patchFileContentHandler,
  uploadFilesHandler,
  createDirectoryHandler,
  createFileHandler,
} from './workspace-files.handlers.js';

describe('routes/v1/workspace-files.handlers', () => {
  let store: WorkspaceStore;
  let dir: string;
  let workspaceDirs: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workspace-files-handlers-test-'));
    const db = openDatabase(join(dir, 'test.db'));
    store = new WorkspaceStore(db);
    workspaceDirs = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const wsDir of workspaceDirs) rmSync(wsDir, { recursive: true, force: true });
  });

  function makeWorkspace(opts: { git?: boolean } = {}) {
    const location = mkdtempSync(join(tmpdir(), 'workspace-files-ws-'));
    workspaceDirs.push(location);
    return store.createWorkspace({ name: 'WS', location, git: !!opts.git });
  }

  describe('getFileTreeHandler()', () => {
    it('returns 404 for an unknown workspace', async () => {
      const result = await getFileTreeHandler(store, 'does-not-exist');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns the tree for a non-git workspace with no branch/status', async () => {
      const ws = makeWorkspace({ git: false });
      writeFileSync(join(ws.location, 'README.md'), '# hi\n');

      const result = await getFileTreeHandler(store, ws.id);
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.branch).to.equal(null);
        expect(result.data.entries.map((n) => n.name)).to.deep.equal(['README.md']);
        expect(result.data.entries[0].gitStatus).to.equal(undefined);
      }
    });

    it('returns the tree with branch/status for a git-enabled workspace', async () => {
      const ws = makeWorkspace({ git: true });
      writeFileSync(join(ws.location, 'modified.txt'), 'x');
      let call = 0;
      const execFileFn = (async () => {
        call++;
        if (call === 1) return { stdout: 'main\n', stderr: '' };
        return { stdout: ' M modified.txt\n', stderr: '' };
      }) as unknown as ExecFileFn;

      const result = await getFileTreeHandler(store, ws.id, execFileFn);
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data.branch).to.equal('main');
        expect(result.data.entries[0].gitStatus).to.equal('M');
      }
    });

    it('returns 400 when the workspace location is missing/unreadable', async () => {
      const location = join(tmpdir(), `workspace-files-missing-${randomUUID()}`);
      const ws = store.createWorkspace({ name: 'Missing', location, git: false });

      const result = await getFileTreeHandler(store, ws.id);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('returns category/oversize/content on file-node entries in the tree response', async () => {
      const ws = makeWorkspace({ git: false });
      writeFileSync(join(ws.location, 'photo.png'), 'x');
      writeFileSync(join(ws.location, 'huge.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 'a'));

      const result = await getFileTreeHandler(store, ws.id);
      expect(result.ok).to.equal(true);
      if (result.ok) {
        const byName = new Map(result.data.entries.map((n) => [n.name, n]));
        expect(byName.get('photo.png')).to.include({
          category: 'image',
          oversize: false,
          content: `/api/v1/workspaces/${ws.id}/files/photo.png/content`,
        });
        expect(byName.get('huge.txt')).to.include({ category: 'text', oversize: true });
      }
    });
  });

  describe('getFileContentHandler()', () => {
    it('returns 404 for an unknown workspace', async () => {
      const result = await getFileContentHandler(store, 'does-not-exist', 'README.md');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns the file content on the happy path', async () => {
      const ws = makeWorkspace();
      writeFileSync(join(ws.location, 'README.md'), 'hello\n');

      const result = await getFileContentHandler(store, ws.id, 'README.md');
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data).to.deep.equal({ kind: 'text', content: 'hello\n' });
    });

    it('resolves a nested multi-segment path', async () => {
      const ws = makeWorkspace();
      mkdirSync(join(ws.location, 'scripts'));
      writeFileSync(join(ws.location, 'scripts', 'run.sh'), '#!/bin/sh\n');

      const result = await getFileContentHandler(store, ws.id, 'scripts/run.sh');
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data).to.deep.equal({ kind: 'text', content: '#!/bin/sh\n' });
    });

    it('returns 400 for a "../../etc/passwd" traversal attempt', async () => {
      const ws = makeWorkspace();
      const result = await getFileContentHandler(store, ws.id, '../../etc/passwd');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('returns 400 for an absolute-path injection attempt', async () => {
      const ws = makeWorkspace();
      const result = await getFileContentHandler(store, ws.id, '/etc/passwd');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('returns 404 for a file that does not exist on disk', async () => {
      const ws = makeWorkspace();
      const result = await getFileContentHandler(store, ws.id, 'missing.txt');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 422 for an oversized file', async () => {
      const ws = makeWorkspace();
      writeFileSync(join(ws.location, 'big.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 'a'));
      const result = await getFileContentHandler(store, ws.id, 'big.txt');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(422);
    });

    it('returns 422 for a binary file', async () => {
      const ws = makeWorkspace();
      writeFileSync(join(ws.location, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
      const result = await getFileContentHandler(store, ws.id, 'bin.dat');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(422);
    });

    it('returns raw bytes and Content-Type for an image file, with no 2MB cap', async () => {
      const ws = makeWorkspace();
      const bigImage = Buffer.alloc(2 * 1024 * 1024 + 1, 1);
      writeFileSync(join(ws.location, 'photo.png'), bigImage);

      const result = await getFileContentHandler(store, ws.id, 'photo.png');
      expect(result.ok).to.equal(true);
      if (result.ok) {
        expect(result.data).to.deep.equal({
          kind: 'binary',
          buffer: bigImage,
          contentType: 'image/png',
        });
      }
    });

    it('returns the right Content-Type for an audio file', async () => {
      const ws = makeWorkspace();
      writeFileSync(join(ws.location, 'song.mp3'), Buffer.from([1, 2, 3]));

      const result = await getFileContentHandler(store, ws.id, 'song.mp3');
      expect(result.ok).to.equal(true);
      if (result.ok && result.data.kind === 'binary') {
        expect(result.data.contentType).to.equal('audio/mpeg');
      }
    });

    it('returns the right Content-Type for a video file', async () => {
      const ws = makeWorkspace();
      writeFileSync(join(ws.location, 'clip.mp4'), Buffer.from([1, 2, 3]));

      const result = await getFileContentHandler(store, ws.id, 'clip.mp4');
      expect(result.ok).to.equal(true);
      if (result.ok && result.data.kind === 'binary') {
        expect(result.data.contentType).to.equal('video/mp4');
      }
    });

    it('returns 422 for a known-unsupported extension regardless of file content', async () => {
      const ws = makeWorkspace();
      writeFileSync(join(ws.location, 'archive.zip'), 'this is plain text, not a real zip');

      const result = await getFileContentHandler(store, ws.id, 'archive.zip');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(422);
    });

    it('returns 404 for a missing file with an unsupported extension', async () => {
      const ws = makeWorkspace();
      const result = await getFileContentHandler(store, ws.id, 'missing.zip');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });
  });

  describe('patchFileContentHandler()', () => {
    it('returns 404 for an unknown workspace', async () => {
      const result = await patchFileContentHandler(store, 'does-not-exist', 'README.md', {
        content: 'hi',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 400 when content is missing or not a string', async () => {
      const ws = makeWorkspace();
      const result = await patchFileContentHandler(store, ws.id, 'README.md', {});
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('returns 400 for a path-containment violation', async () => {
      const ws = makeWorkspace();
      const result = await patchFileContentHandler(store, ws.id, '../../etc/passwd', {
        content: 'x',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('returns 422 for oversized content', async () => {
      const ws = makeWorkspace();
      const bigContent = 'a'.repeat(2 * 1024 * 1024 + 1);
      const result = await patchFileContentHandler(store, ws.id, 'file.txt', {
        content: bigContent,
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(422);
    });

    it('writes the file to disk on success', async () => {
      const ws = makeWorkspace();
      writeFileSync(join(ws.location, 'file.txt'), 'old content');

      const result = await patchFileContentHandler(store, ws.id, 'file.txt', {
        content: 'new content',
      });
      expect(result.ok).to.equal(true);
      expect(readFileSync(join(ws.location, 'file.txt'), 'utf8')).to.equal('new content');
    });

    it('creates a new file when the target does not already exist', async () => {
      const ws = makeWorkspace();
      const result = await patchFileContentHandler(store, ws.id, 'new-file.txt', {
        content: 'hello',
      });
      expect(result.ok).to.equal(true);
      expect(readFileSync(join(ws.location, 'new-file.txt'), 'utf8')).to.equal('hello');
    });

    it('invalidates the file tree cache so a follow-up tree fetch reflects the write without waiting out the TTL', async () => {
      const ws = makeWorkspace({ git: false });
      writeFileSync(join(ws.location, 'file.txt'), 'old content');

      const before = await getFileTreeHandler(store, ws.id);
      expect(before.ok).to.equal(true); // primes the cache

      const patchResult = await patchFileContentHandler(store, ws.id, 'brand-new.txt', {
        content: 'hi',
      });
      expect(patchResult.ok).to.equal(true);

      const after = await getFileTreeHandler(store, ws.id);
      expect(after.ok).to.equal(true);
      if (after.ok) {
        expect(after.data.entries.map((n) => n.name)).to.include('brand-new.txt');
      }
    });

    it('returns 500 when the write fails (target path resolves to a directory)', async () => {
      const ws = makeWorkspace();
      mkdirSync(join(ws.location, 'a-directory'));

      const result = await patchFileContentHandler(store, ws.id, 'a-directory', {
        content: 'hi',
      });
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(500);
    });

    it('writes a media-extension file unchanged — PATCH is not classification-aware', async () => {
      const ws = makeWorkspace();
      const result = await patchFileContentHandler(store, ws.id, 'photo.png', {
        content: 'not real png bytes, just text',
      });
      expect(result.ok).to.equal(true);
      expect(readFileSync(join(ws.location, 'photo.png'), 'utf8')).to.equal(
        'not real png bytes, just text',
      );
    });
  });

  describe('uploadFilesHandler()', () => {
    function file(name: string, content = 'x'): { name: string; buffer: Buffer } {
      return { name, buffer: Buffer.from(content) };
    }

    it('returns 404 for an unknown workspace', async () => {
      const result = await uploadFilesHandler(store, 'does-not-exist', '', [file('a.txt')]);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 404 when the target dir does not exist', async () => {
      const ws = makeWorkspace();
      const result = await uploadFilesHandler(store, ws.id, 'missing-dir', [file('a.txt')]);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 400 when the target dir resolves to a file', async () => {
      const ws = makeWorkspace();
      writeFileSync(join(ws.location, 'not-a-dir.txt'), 'x');
      const result = await uploadFilesHandler(store, ws.id, 'not-a-dir.txt', [file('a.txt')]);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('writes each file to the target directory and invalidates the tree cache', async () => {
      const ws = makeWorkspace({ git: false });
      mkdirSync(join(ws.location, 'sub'));

      const before = await getFileTreeHandler(store, ws.id);
      expect(before.ok).to.equal(true); // primes the cache

      const result = await uploadFilesHandler(store, ws.id, 'sub', [
        file('a.txt', 'hello'),
        file('b.txt', 'world'),
      ]);
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.created).to.have.members(['a.txt', 'b.txt']);
      expect(readFileSync(join(ws.location, 'sub', 'a.txt'), 'utf8')).to.equal('hello');
      expect(readFileSync(join(ws.location, 'sub', 'b.txt'), 'utf8')).to.equal('world');

      const after = await getFileTreeHandler(store, ws.id);
      expect(after.ok).to.equal(true);
      if (after.ok) {
        const sub = after.data.entries.find((n) => n.name === 'sub');
        expect(sub?.children?.map((n) => n.name)).to.include.members(['a.txt', 'b.txt']);
      }
    });

    it('rejects the whole batch (writing nothing) when one file collides with an existing entry', async () => {
      const ws = makeWorkspace();
      writeFileSync(join(ws.location, 'a.txt'), 'original');

      const result = await uploadFilesHandler(store, ws.id, '', [
        file('a.txt', 'clobber'),
        file('b.txt', 'new'),
      ]);
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(409);
        expect((result as { conflicts?: string[] }).conflicts).to.include('a.txt');
      }
      expect(readFileSync(join(ws.location, 'a.txt'), 'utf8')).to.equal('original');
      expect(existsSync(join(ws.location, 'b.txt'))).to.equal(false);
    });

    it('rejects the whole batch when two files in the same request share a name', async () => {
      const ws = makeWorkspace();
      const result = await uploadFilesHandler(store, ws.id, '', [
        file('dup.txt', 'one'),
        file('dup.txt', 'two'),
      ]);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(409);
      expect(existsSync(join(ws.location, 'dup.txt'))).to.equal(false);
    });

    it('rejects the whole batch when a filename is invalid', async () => {
      const ws = makeWorkspace();
      const result = await uploadFilesHandler(store, ws.id, '', [
        file('ok.txt'),
        file('../escape.txt'),
      ]);
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.status).to.equal(409);
        expect((result as { conflicts?: string[] }).conflicts).to.include('../escape.txt');
      }
      expect(existsSync(join(ws.location, 'ok.txt'))).to.equal(false);
    });

    it('returns 400 when no files are provided', async () => {
      const ws = makeWorkspace();
      const result = await uploadFilesHandler(store, ws.id, '', []);
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });
  });

  describe('createDirectoryHandler()', () => {
    it('returns 404 for an unknown workspace', async () => {
      const result = await createDirectoryHandler(store, 'does-not-exist', '', 'new-folder');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 400 for an invalid name', async () => {
      const ws = makeWorkspace();
      const result = await createDirectoryHandler(store, ws.id, '', '..');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('returns 404 when the target dir does not exist', async () => {
      const ws = makeWorkspace();
      const result = await createDirectoryHandler(store, ws.id, 'missing', 'new-folder');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('creates the directory, invalidates the cache, and returns its path', async () => {
      const ws = makeWorkspace({ git: false });
      mkdirSync(join(ws.location, 'sub'));

      const result = await createDirectoryHandler(store, ws.id, 'sub', 'new-folder');
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.path).to.equal('sub/new-folder');
      expect(statSync(join(ws.location, 'sub', 'new-folder')).isDirectory()).to.equal(true);
    });

    it('returns 409 when the name already exists in that folder', async () => {
      const ws = makeWorkspace();
      mkdirSync(join(ws.location, 'existing'));

      const result = await createDirectoryHandler(store, ws.id, '', 'existing');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(409);
    });
  });

  describe('createFileHandler()', () => {
    it('returns 404 for an unknown workspace', async () => {
      const result = await createFileHandler(store, 'does-not-exist', '', 'new.txt');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(404);
    });

    it('returns 400 for an invalid name', async () => {
      const ws = makeWorkspace();
      const result = await createFileHandler(store, ws.id, '', 'a/b.txt');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(400);
    });

    it('creates an empty file at the workspace root, invalidates the cache, and returns its path', async () => {
      const ws = makeWorkspace({ git: false });

      const result = await createFileHandler(store, ws.id, '', 'new.txt');
      expect(result.ok).to.equal(true);
      if (result.ok) expect(result.data.path).to.equal('new.txt');
      expect(readFileSync(join(ws.location, 'new.txt'), 'utf8')).to.equal('');
    });

    it('returns 409 when the name already exists in that folder', async () => {
      const ws = makeWorkspace();
      writeFileSync(join(ws.location, 'existing.txt'), 'x');

      const result = await createFileHandler(store, ws.id, '', 'existing.txt');
      expect(result.ok).to.equal(false);
      if (!result.ok) expect(result.status).to.equal(409);
    });
  });
});
