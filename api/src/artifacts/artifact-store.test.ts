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
  getExtractedText,
  deleteArtifact,
  markArtifactReferenced,
  listArtifactMeta,
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
      expect(artifact!.web).to.not.equal(null);
      expect(artifact!.web!.toString()).to.equal('web-bytes');
      expect(artifact!.preview).to.not.equal(null);
      expect(artifact!.preview!.toString()).to.equal('preview-bytes');

      const meta = getArtifactMeta(id);
      expect(meta).to.not.equal(undefined);
      expect(meta!.id).to.equal(id);
      expect(meta!.mimeType).to.equal('image/png');
      expect(meta!.originalFilename).to.equal('original.png');
      expect(meta!.hasVariants).to.equal(true);
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

  describe('non-image artifacts (no processed variants)', () => {
    let dir: string;

    before(async () => {
      dir = mkdtempSync(join(tmpdir(), 'artifact-store-no-variants-test-'));
      await bootArtifactStore(dir);
    });
    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('stores just original + meta.json when web/preview are omitted', async () => {
      const id = await storeArtifact({
        mimeType: 'text/markdown',
        original: Buffer.from('# Hello'),
      });

      const meta = getArtifactMeta(id);
      expect(meta!.hasVariants).to.equal(false);
      expect(meta!.originalFilename).to.equal('original.markdown');

      const artifact = await getArtifact(id);
      expect(artifact!.original.toString()).to.equal('# Hello');
      expect(artifact!.web).to.equal(null);
      expect(artifact!.preview).to.equal(null);
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

  describe('displayFilename / requiresVision / extractedText', () => {
    let dir: string;

    before(async () => {
      dir = mkdtempSync(join(tmpdir(), 'artifact-store-attachment-test-'));
      await bootArtifactStore(dir);
    });
    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('round-trips a provided displayFilename', async () => {
      const id = await storeArtifact(makeInput({ displayFilename: 'vacation.png' }));
      expect(getArtifactMeta(id)!.displayFilename).to.equal('vacation.png');
    });

    it('defaults displayFilename to originalFilename when omitted', async () => {
      const id = await storeArtifact(makeInput());
      const meta = getArtifactMeta(id)!;
      expect(meta.displayFilename).to.equal(meta.originalFilename);
    });

    it('defaults requiresVision to false when omitted', async () => {
      const id = await storeArtifact(makeInput());
      expect(getArtifactMeta(id)!.requiresVision).to.equal(false);
    });

    it('round-trips requiresVision: true', async () => {
      const id = await storeArtifact(makeInput({ requiresVision: true }));
      expect(getArtifactMeta(id)!.requiresVision).to.equal(true);
    });

    it('stores and reads back extractedText via getExtractedText', async () => {
      const id = await storeArtifact(makeInput({ extractedText: 'hello from the pdf' }));
      const meta = getArtifactMeta(id)!;
      expect(meta.hasExtractedText).to.equal(true);
      expect(await getExtractedText(id)).to.equal('hello from the pdf');
    });

    it('getExtractedText returns null when no text was ever written', async () => {
      const id = await storeArtifact(makeInput());
      expect(getArtifactMeta(id)!.hasExtractedText).to.equal(false);
      expect(await getExtractedText(id)).to.equal(null);
    });

    it('derives a .docx extension for the docx MIME type', async () => {
      const id = await storeArtifact(
        makeInput({
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      );
      expect(getArtifactMeta(id)!.originalFilename).to.equal('original.docx');
    });
  });

  describe('deleteArtifact()', () => {
    let dir: string;

    before(async () => {
      dir = mkdtempSync(join(tmpdir(), 'artifact-store-delete-test-'));
      await bootArtifactStore(dir);
    });
    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns false for an unknown id without throwing', async () => {
      expect(await deleteArtifact('nonexistent')).to.equal(false);
    });

    it('removes the directory and index entry for a real artifact', async () => {
      const id = await storeArtifact(makeInput());
      expect(await deleteArtifact(id)).to.equal(true);
      expect(getArtifactMeta(id)).to.equal(undefined);
      expect(await getArtifact(id)).to.equal(undefined);
    });
  });

  describe('markArtifactReferenced() / listArtifactMeta()', () => {
    let dir: string;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'artifact-store-referenced-test-'));
    });
    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('sets referencedAt and it survives a reboot against the same directory', async () => {
      await bootArtifactStore(dir);
      const id = await storeArtifact(makeInput());
      expect(getArtifactMeta(id)!.referencedAt).to.equal(null);

      const now = new Date('2026-01-01T00:00:00.000Z');
      await markArtifactReferenced(id, now);
      expect(getArtifactMeta(id)!.referencedAt).to.equal(now.toISOString());

      // Simulate a restart — referencedAt must have been persisted to disk,
      // not just mutated in memory, or a real restart would make every
      // previously-sent attachment look orphaned again.
      await bootArtifactStore(dir);
      expect(getArtifactMeta(id)!.referencedAt).to.equal(now.toISOString());
    });

    it('does not overwrite an already-set referencedAt', async () => {
      await bootArtifactStore(dir);
      const id = await storeArtifact(makeInput());
      const first = new Date('2026-01-01T00:00:00.000Z');
      const second = new Date('2026-06-01T00:00:00.000Z');

      await markArtifactReferenced(id, first);
      await markArtifactReferenced(id, second);

      expect(getArtifactMeta(id)!.referencedAt).to.equal(first.toISOString());
    });

    it('listArtifactMeta includes every stored artifact', async () => {
      await bootArtifactStore(dir);
      const idA = await storeArtifact(makeInput());
      const idB = await storeArtifact(makeInput());
      const ids = listArtifactMeta().map((m) => m.id);
      expect(ids).to.include(idA);
      expect(ids).to.include(idB);
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
