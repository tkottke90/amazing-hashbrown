import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import {
  bootArtifactStore,
  getArtifactMeta,
  storeArtifact,
} from '../../artifacts/artifact-store.js';
import {
  uploadArtifactHandler,
  deleteArtifactHandler,
  resolveEffectiveMimeType,
} from './artifacts.handlers.js';

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

    it('rejects an unsupported MIME type with a 400', async () => {
      const result = await uploadArtifactHandler({
        mimeType: 'application/zip',
        original: Buffer.from('whatever'),
      });

      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(400);
      expect(result.error).to.match(/unsupported file type/i);
    });

    it('classifies an uploaded image as requiring vision', async () => {
      const result = await uploadArtifactHandler({
        mimeType: 'image/png',
        original: Buffer.from(TINY_PNG_BASE64, 'base64'),
      });

      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data.requiresVision).to.equal(true);
      expect(result.data.hasExtractedText).to.equal(false);
    });

    it('classifies an uploaded text/markdown file as not requiring vision, extracting its text', async () => {
      const result = await uploadArtifactHandler({
        mimeType: 'text/markdown',
        original: Buffer.from('# Hello'),
      });

      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data.requiresVision).to.equal(false);
      expect(result.data.hasExtractedText).to.equal(true);
    });

    it('round-trips displayFilename from the upload input', async () => {
      const result = await uploadArtifactHandler({
        mimeType: 'text/plain',
        original: Buffer.from('hi'),
        displayFilename: 'notes.txt',
      });

      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data.displayFilename).to.equal('notes.txt');
    });

    it('accepts a previously-rejected text/* type (text/csv)', async () => {
      const result = await uploadArtifactHandler({
        mimeType: 'text/csv',
        original: Buffer.from('a,b,c'),
      });

      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data.mimeType).to.equal('text/csv');
      expect(result.data.requiresVision).to.equal(false);
    });

    it('accepts application/json', async () => {
      const result = await uploadArtifactHandler({
        mimeType: 'application/json',
        original: Buffer.from('{"a":1}'),
      });

      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data.mimeType).to.equal('application/json');
    });

    it('normalizes a YAML MIME alias and accepts the upload', async () => {
      const result = await uploadArtifactHandler({
        mimeType: 'application/x-yaml',
        original: Buffer.from('a: 1'),
        displayFilename: 'config.yaml',
      });

      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data.mimeType).to.equal('application/yaml');
    });

    it('sniffs a generic MIME type from the .yaml extension and accepts the upload', async () => {
      const result = await uploadArtifactHandler({
        mimeType: 'application/octet-stream',
        original: Buffer.from('a: 1'),
        displayFilename: 'config.yaml',
      });

      expect(result.ok).to.equal(true);
      if (!result.ok) return;
      expect(result.data.mimeType).to.equal('application/yaml');
    });

    it('still rejects a generic MIME type with an unrecognized extension', async () => {
      const result = await uploadArtifactHandler({
        mimeType: 'application/octet-stream',
        original: Buffer.from('whatever'),
        displayFilename: 'notes.log',
      });

      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(400);
      expect(result.error).to.match(/unsupported file type/i);
    });
  });

  describe('resolveEffectiveMimeType', () => {
    it('normalizes every known YAML alias to application/yaml', () => {
      expect(resolveEffectiveMimeType('application/x-yaml', 'a.yaml')).to.equal('application/yaml');
      expect(resolveEffectiveMimeType('text/yaml', 'a.yaml')).to.equal('application/yaml');
      expect(resolveEffectiveMimeType('text/x-yaml', 'a.yaml')).to.equal('application/yaml');
    });

    it('sniffs a generic/empty type from a recognized extension', () => {
      expect(resolveEffectiveMimeType('application/octet-stream', 'config.yaml')).to.equal(
        'application/yaml',
      );
      expect(resolveEffectiveMimeType('application/octet-stream', 'config.yml')).to.equal(
        'application/yaml',
      );
      expect(resolveEffectiveMimeType('', 'data.json')).to.equal('application/json');
      expect(resolveEffectiveMimeType('', 'notes.md')).to.equal('text/markdown');
      expect(resolveEffectiveMimeType('', 'notes.txt')).to.equal('text/plain');
    });

    it('passes a generic type through unchanged for an unrecognized extension', () => {
      expect(resolveEffectiveMimeType('application/octet-stream', 'notes.log')).to.equal(
        'application/octet-stream',
      );
      expect(resolveEffectiveMimeType('', 'notes.log')).to.equal('');
    });

    it('never overrides an explicit, non-generic type even if the extension disagrees', () => {
      expect(resolveEffectiveMimeType('text/plain', 'config.yaml')).to.equal('text/plain');
    });
  });

  describe('deleteArtifactHandler', () => {
    let dir: string;

    before(async () => {
      dir = mkdtempSync(join(tmpdir(), 'artifacts-handlers-delete-test-'));
      await bootArtifactStore(dir);
    });
    after(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns 404 for an unknown id', async () => {
      const result = await deleteArtifactHandler('nonexistent');
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(404);
    });

    it('returns 403 for an agent-generated artifact and does not delete it', async () => {
      const id = await storeArtifact({
        mimeType: 'image/png',
        original: Buffer.from(TINY_PNG_BASE64, 'base64'),
        origin: 'agent-generated',
      });

      const result = await deleteArtifactHandler(id);
      expect(result.ok).to.equal(false);
      if (result.ok) return;
      expect(result.status).to.equal(403);
      expect(getArtifactMeta(id)).to.not.equal(undefined);
    });

    it('deletes a user-upload artifact', async () => {
      const uploadResult = await uploadArtifactHandler({
        mimeType: 'text/plain',
        original: Buffer.from('hi'),
      });
      expect(uploadResult.ok).to.equal(true);
      if (!uploadResult.ok) return;

      const result = await deleteArtifactHandler(uploadResult.data.id);
      expect(result.ok).to.equal(true);
      expect(getArtifactMeta(uploadResult.data.id)).to.equal(undefined);
    });
  });
});
