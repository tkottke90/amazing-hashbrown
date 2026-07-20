import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { bootArtifactStore } from '../../artifacts/artifact-store.js';
import { uploadArtifactHandler } from './artifacts.handlers.js';

// A real, valid 1x1 transparent PNG — small enough to embed inline, but a
// genuine image sharp can decode (verified against real `sharp` output, not
// assumed). Lets tests exercise the real processImage() path without a
// fixture file on disk.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('routes/v1/artifacts.handlers', () => {
  describe('uploadArtifactHandler', () => {
    let dir: string;

    before(async () => {
      dir = mkdtempSync(join(tmpdir(), 'artifacts-handlers-test-'));
      await bootArtifactStore(dir);
    });
    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('processes a real image into web/preview variants', async () => {
      const result = await uploadArtifactHandler({
        mimeType: 'image/png',
        original: Buffer.from(TINY_PNG_BASE64, 'base64'),
      });

      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data.mimeType).to.equal('image/png');
      expect(result.data.hasVariants).to.equal(true);
    });

    it('stores a non-image file as-is, with no processed variants', async () => {
      const result = await uploadArtifactHandler({
        mimeType: 'text/markdown',
        original: Buffer.from('# Hello'),
      });

      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data.mimeType).to.equal('text/markdown');
      expect(result.data.hasVariants).to.equal(false);
    });

    it('returns a 400 invalid result when an "image/*" upload is not a decodable image', async () => {
      const result = await uploadArtifactHandler({
        mimeType: 'image/png',
        original: Buffer.from('this is not a real png'),
      });

      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(400);
      expect(result.error).to.match(/failed to process image/i);
    });

    it('passes threadId/taskId through into the stored meta when provided', async () => {
      const result = await uploadArtifactHandler({
        mimeType: 'text/plain',
        original: Buffer.from('hi'),
        threadId: 'thread-1',
        taskId: 'task-1',
      });

      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data.threadId).to.equal('thread-1');
      expect(result.data.taskId).to.equal('task-1');
    });

    it('leaves threadId/taskId null when omitted', async () => {
      const result = await uploadArtifactHandler({
        mimeType: 'text/plain',
        original: Buffer.from('hi'),
      });

      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data.threadId).to.equal(null);
      expect(result.data.taskId).to.equal(null);
    });
  });
});
