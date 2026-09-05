import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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
});
