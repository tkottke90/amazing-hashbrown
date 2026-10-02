import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { bootArtifactStore, storeArtifact, getArtifactMeta } from '../artifacts/artifact-store.js';
import { getToolContent } from '../services/tool-content-store.js';
import { STUB_THRESHOLD_CHARS } from './tools/tool-stub.js';
import { resolveAttachmentsForTurn, buildAttachmentSpan } from './attachment-resolution.js';

describe('resolveAttachmentsForTurn [unit]', () => {
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'attachment-resolution-test-'));
    await bootArtifactStore(dir);
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves to empty arrays for an empty attachmentIds list', async () => {
    const result = await resolveAttachmentsForTurn([], 'thread-1', 'p', 'm');
    expect(result).to.deep.equal({ records: [], injections: [] });
  });

  it('skips an unknown attachmentId, contributing nothing to either array', async () => {
    const result = await resolveAttachmentsForTurn(['nonexistent'], 'thread-1', 'p', 'm');
    expect(result).to.deep.equal({ records: [], injections: [] });
  });

  it('excludes a vision-required attachment when the model lacks vision support, with a notice the agent can relay', async () => {
    const id = await storeArtifact({
      mimeType: 'image/png',
      original: Buffer.from('fake-image-bytes'),
      displayFilename: 'photo.png',
      requiresVision: true,
    });

    const result = await resolveAttachmentsForTurn([id], 'thread-1', 'p', 'm', async () => false);

    expect(result.records[0]).to.deep.equal({
      id,
      filename: 'photo.png',
      mimeType: 'image/png',
      included: false,
      exclusionReason: 'vision_unsupported',
    });
    expect(result.injections[0]!.kind).to.equal('excluded');
    expect((result.injections[0] as { notation: string }).notation).to.include('photo.png');
    expect((result.injections[0] as { notation: string }).notation).to.include(
      'does not support image input',
    );
  });

  it('excludes with exclusionReason "artifact_missing" when the artifact bytes are gone from disk', async () => {
    const id = await storeArtifact({
      mimeType: 'image/png',
      original: Buffer.from('fake-image-bytes'),
      displayFilename: 'photo.png',
      requiresVision: true,
    });
    const meta = getArtifactMeta(id)!;
    // Simulate corruption/loss: metadata resolves, but the bytes on disk
    // don't — the fallback path resolveAttachmentsForTurn exercises when
    // getArtifact() returns undefined despite a valid meta lookup.
    unlinkSync(join(dir, id, meta.originalFilename));

    const result = await resolveAttachmentsForTurn([id], 'thread-1', 'p', 'm', async () => true);

    expect(result.records[0]).to.deep.equal({
      id,
      filename: 'photo.png',
      mimeType: 'image/png',
      included: false,
      exclusionReason: 'artifact_missing',
    });
    expect(result.injections[0]!.kind).to.equal('excluded');
    expect((result.injections[0] as { notation: string }).notation).to.include(
      'no longer available',
    );
  });

  it('builds a multimodal injection for a vision-required attachment when the model supports vision', async () => {
    const original = Buffer.from('fake-image-bytes');
    const id = await storeArtifact({
      mimeType: 'image/png',
      original,
      displayFilename: 'photo.png',
      requiresVision: true,
    });

    const result = await resolveAttachmentsForTurn([id], 'thread-1', 'p', 'm', async () => true);

    expect(result.injections[0]).to.deep.equal({
      kind: 'multimodal',
      imageBlock: { type: 'image', mimeType: 'image/png', data: original.toString('base64') },
    });
    expect(result.records[0]).to.deep.equal({
      id,
      filename: 'photo.png',
      mimeType: 'image/png',
      included: true,
    });
  });

  it('inlines extracted text for a small document attachment without ever checking vision capability', async () => {
    const id = await storeArtifact({
      mimeType: 'text/plain',
      original: Buffer.from('the doc bytes'),
      displayFilename: 'notes.txt',
      requiresVision: false,
      extractedText: 'the extracted notes',
    });

    let checkVisionCalled = false;
    const result = await resolveAttachmentsForTurn([id], 'thread-1', 'p', 'm', async () => {
      checkVisionCalled = true;
      return false;
    });

    expect(checkVisionCalled).to.equal(false);
    expect(result.injections[0]).to.deep.equal({
      kind: 'text',
      notation: '---\nAttached file "notes.txt":\nthe extracted notes',
    });
    expect(result.records[0]).to.deep.equal({
      id,
      filename: 'notes.txt',
      mimeType: 'text/plain',
      included: true,
    });
  });

  it('offloads a large document attachment to the KV store with a get_tool_key stub instead of inlining it', async () => {
    const threadId = `thread-${randomUUID()}`;
    const bigText = 'x'.repeat(STUB_THRESHOLD_CHARS + 1);
    const id = await storeArtifact({
      mimeType: 'text/markdown',
      original: Buffer.from('ignored — extractedText drives this path'),
      displayFilename: 'report.md',
      requiresVision: false,
      extractedText: bigText,
    });

    const result = await resolveAttachmentsForTurn([id], threadId, 'p', 'm');

    expect(result.injections[0]!.kind).to.equal('text');
    const notation = (result.injections[0] as { notation: string }).notation;
    expect(notation).to.include('── CONTENT OFFLOADED ──');
    expect(notation).to.include('kind: attachment');
    expect(notation).to.include('report.md');
    expect(notation).to.include('get_tool_key({');
    expect(notation).to.include(threadId);

    // The toolKey embedded in the stub must actually resolve back to the
    // full text — this is the whole point of offloading instead of inlining.
    const toolKeyMatch = notation.match(/toolKey:\s*"([^"]+)"/);
    expect(toolKeyMatch, 'stub must embed a real toolKey').to.not.equal(null);
    const stored = getToolContent(threadId, toolKeyMatch![1]!);
    expect(stored).to.equal(bigText);
  });

  it('inlines a document attachment exactly at the threshold without offloading', async () => {
    const exactText = 'y'.repeat(STUB_THRESHOLD_CHARS);
    const id = await storeArtifact({
      mimeType: 'text/plain',
      original: Buffer.from('ignored'),
      displayFilename: 'exact.txt',
      requiresVision: false,
      extractedText: exactText,
    });

    const result = await resolveAttachmentsForTurn([id], 'thread-1', 'p', 'm');

    expect(result.injections[0]).to.deep.equal({
      kind: 'text',
      notation: `---\nAttached file "exact.txt":\n${exactText}`,
    });
  });

  it('preserves order across a multi-id turn, resolving each id independently', async () => {
    const imageId = await storeArtifact({
      mimeType: 'image/png',
      original: Buffer.from('fake-image-bytes'),
      displayFilename: 'photo.png',
      requiresVision: true,
    });
    const docId = await storeArtifact({
      mimeType: 'text/plain',
      original: Buffer.from('the doc bytes'),
      displayFilename: 'notes.txt',
      requiresVision: false,
      extractedText: 'the extracted notes',
    });

    const result = await resolveAttachmentsForTurn(
      [imageId, docId],
      'thread-1',
      'p',
      'm',
      async () => true,
    );

    expect(result.records.map((r) => r.id)).to.deep.equal([imageId, docId]);
    expect(result.injections[0]!.kind).to.equal('multimodal');
    expect(result.injections[1]!.kind).to.equal('text');
  });

  it('calls checkVision at most once across several vision-gated attachments on the same turn', async () => {
    const firstImage = await storeArtifact({
      mimeType: 'image/png',
      original: Buffer.from('fake-image-bytes-1'),
      displayFilename: 'photo-1.png',
      requiresVision: true,
    });
    const secondImage = await storeArtifact({
      mimeType: 'image/png',
      original: Buffer.from('fake-image-bytes-2'),
      displayFilename: 'photo-2.png',
      requiresVision: true,
    });

    let callCount = 0;
    await resolveAttachmentsForTurn([firstImage, secondImage], 'thread-1', 'p', 'm', async () => {
      callCount++;
      return true;
    });

    expect(callCount).to.equal(1);
  });

  it('resolves sibling ids normally when one id in the batch has no artifact metadata', async () => {
    const docId = await storeArtifact({
      mimeType: 'text/plain',
      original: Buffer.from('the doc bytes'),
      displayFilename: 'notes.txt',
      requiresVision: false,
      extractedText: 'the extracted notes',
    });

    const result = await resolveAttachmentsForTurn(
      ['nonexistent', docId],
      'thread-1',
      'p',
      'm',
      async () => true,
    );

    expect(result.records).to.have.lengthOf(1);
    expect(result.records[0]!.id).to.equal(docId);
  });

  it('produces independent outcomes for a mixed excluded-image / included-doc batch sharing one vision decision', async () => {
    const imageId = await storeArtifact({
      mimeType: 'image/png',
      original: Buffer.from('fake-image-bytes'),
      displayFilename: 'photo.png',
      requiresVision: true,
    });
    const docId = await storeArtifact({
      mimeType: 'text/plain',
      original: Buffer.from('the doc bytes'),
      displayFilename: 'notes.txt',
      requiresVision: false,
      extractedText: 'the extracted notes',
    });

    // The model lacks vision: the image is excluded, but the doc — which
    // never requires vision — still resolves as included, independently.
    const result = await resolveAttachmentsForTurn(
      [imageId, docId],
      'thread-1',
      'p',
      'm',
      async () => false,
    );

    expect(result.records).to.have.lengthOf(2);
    expect(result.records[0]).to.deep.equal({
      id: imageId,
      filename: 'photo.png',
      mimeType: 'image/png',
      included: false,
      exclusionReason: 'vision_unsupported',
    });
    expect(result.records[1]).to.deep.equal({
      id: docId,
      filename: 'notes.txt',
      mimeType: 'text/plain',
      included: true,
    });
  });
});

describe('buildAttachmentSpan [unit]', () => {
  it('shapes an included-attachment span with no exclusionReason key', () => {
    const span = buildAttachmentSpan('trace-1', '2024-01-01T00:00:00.000Z', {
      id: 'att-1',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      included: true,
    });

    expect(span.type).to.equal('attachment');
    expect(span.name).to.equal('attachment-included');
    expect(span.traceId).to.equal('trace-1');
    expect(JSON.parse(span.outputPreview!)).to.deep.equal({
      artifactId: 'att-1',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      included: true,
    });
  });

  it('shapes an excluded-attachment span including exclusionReason', () => {
    const span = buildAttachmentSpan('trace-1', '2024-01-01T00:00:00.000Z', {
      id: 'att-2',
      filename: 'photo.png',
      mimeType: 'image/png',
      included: false,
      exclusionReason: 'vision_unsupported',
    });

    expect(span.name).to.equal('attachment-excluded');
    expect(JSON.parse(span.outputPreview!)).to.deep.equal({
      artifactId: 'att-2',
      filename: 'photo.png',
      mimeType: 'image/png',
      included: false,
      exclusionReason: 'vision_unsupported',
    });
  });
});
