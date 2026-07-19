import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import {
  bootArtifactStore,
  storeArtifact,
  getArtifact,
  getArtifactMeta,
} from './artifact-store.js';

function makeInput(overrides: Partial<Parameters<typeof storeArtifact>[0]> = {}) {
  return {
    mimeType: 'image/png',
    original: Buffer.from('original-bytes'),
    web: Buffer.from('web-bytes'),
    preview: Buffer.from('preview-bytes'),
    ...overrides,
  };
}

describe('artifacts/artifact-store', () => {
  // Must run before any other describe block in this file calls
  // bootArtifactStore() — module-level store state is a singleton, and this
  // test relies on it never having been initialised yet.
  describe('uninitialised store', () => {
    it('throws when storeArtifact is called before bootArtifactStore', async () => {
      let threw = false;
      try {
        await storeArtifact(makeInput());
      } catch {
        threw = true;
      }
      expect(threw).to.equal(true);
    });
  });

  describe('bootArtifactStore / storeArtifact / getArtifact', () => {
    let dir: string;

    before(async () => {
      dir = mkdtempSync(join(tmpdir(), 'artifact-store-test-'));
      await bootArtifactStore(dir);
    });
    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('starts with an empty index after boot', async () => {
      expect(getArtifactMeta('nonexistent')).to.equal(undefined);
      expect(await getArtifact('nonexistent')).to.equal(undefined);
    });

    it('writes original/web/preview/meta and round-trips through getArtifact', async () => {
      const id = await storeArtifact(makeInput());

      const artifact = await getArtifact(id);
      expect(artifact).to.not.equal(undefined);
      expect(artifact!.mimeType).to.equal('image/png');
      expect(artifact!.original.toString()).to.equal('original-bytes');
      expect(artifact!.web.toString()).to.equal('web-bytes');
      expect(artifact!.preview.toString()).to.equal('preview-bytes');

      const meta = getArtifactMeta(id);
      expect(meta).to.not.equal(undefined);
      expect(meta!.id).to.equal(id);
      expect(meta!.mimeType).to.equal('image/png');
      expect(meta!.originalFilename).to.equal('original.png');
      expect(meta!.origin).to.equal('user-upload');
      expect(meta!.threadId).to.equal(null);
      expect(meta!.taskId).to.equal(null);
    });

    it('derives the original filename extension from the MIME type', async () => {
      const id = await storeArtifact(makeInput({ mimeType: 'image/jpeg' }));
      const meta = getArtifactMeta(id);
      expect(meta!.originalFilename).to.equal('original.jpg');
    });

    it('records origin/threadId/taskId when provided', async () => {
      const id = await storeArtifact(
        makeInput({ origin: 'agent-generated', threadId: 'thread-1', taskId: 'task-1' }),
      );
      const meta = getArtifactMeta(id);
      expect(meta!.origin).to.equal('agent-generated');
      expect(meta!.threadId).to.equal('thread-1');
      expect(meta!.taskId).to.equal('task-1');
    });
  });

  describe('restart survival', () => {
    let dir: string;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'artifact-store-restart-test-'));
    });
    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('rehydrates previously-written artifacts on a second boot', async () => {
      await bootArtifactStore(dir);
      const id = await storeArtifact(makeInput({ mimeType: 'image/webp' }));

      // Simulate an API restart: re-boot against the same directory.
      await bootArtifactStore(dir);

      const meta = getArtifactMeta(id);
      expect(meta).to.not.equal(undefined);
      expect(meta!.mimeType).to.equal('image/webp');

      const artifact = await getArtifact(id);
      expect(artifact!.original.toString()).to.equal('original-bytes');
    });
  });

  describe('boot resilience', () => {
    let dir: string;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'artifact-store-corrupt-test-'));
    });
    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('skips a directory with a missing/corrupt meta.json instead of throwing', async () => {
      const badDir = join(dir, 'not-real-meta');
      mkdirSync(badDir, { recursive: true });
      writeFileSync(join(badDir, 'meta.json'), 'not valid json');

      await bootArtifactStore(dir);

      expect(getArtifactMeta('not-real-meta')).to.equal(undefined);
    });
  });
});
