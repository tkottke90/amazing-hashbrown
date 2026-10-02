import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { bootArtifactStore, storeArtifact, getArtifactMeta } from '../artifacts/artifact-store.js';
import { getToolContent, getToolContentEntry } from '../services/tool-content-store.js';
import { STUB_THRESHOLD_CHARS } from './tools/tool-stub.js';
import { resolveAttachmentForTurn, buildAttachmentSpan } from './attachment-resolution.js';

describe('resolveAttachmentForTurn [unit]', () => {
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'attachment-resolution-test-'));
    await bootArtifactStore(dir);
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves to undefined when no attachmentId is given', async () => {
    const result = await resolveAttachmentForTurn(undefined, 'thread-1', 'p', 'm');
    expect(result).to.equal(undefined);
  });

  it('resolves to undefined for an unknown attachmentId', async () => {
    const result = await resolveAttachmentForTurn('nonexistent', 'thread-1', 'p', 'm');
    expect(result).to.equal(undefined);
  });

  it('excludes a vision-required attachment when the model lacks vision support, with a notice the agent can relay', async () => {
    const id = await storeArtifact({
      mimeType: 'image/png',
      original: Buffer.from('fake-image-bytes'),
      displayFilename: 'photo.png',
      requiresVision: true,
    });

    const result = await resolveAttachmentForTurn(id, 'thread-1', 'p', 'm', async () => false);

    expect(result?.record).to.deep.equal({
      id,
      filename: 'photo.png',
      mimeType: 'image/png',
      included: false,
      exclusionReason: 'vision_unsupported',
    });
    expect(result?.injection.kind).to.equal('excluded');
    const notation = (result?.injection as { notation: string }).notation;
    expect(notation).to.include('photo.png');
    expect(notation).to.include('does not support image input');
    expect(notation).to.include('retried via get_tool_key({ threadId: "thread-1"');

    // The embedded toolKey must resolve to a binary pointer at the real
    // attachmentId, so a later turn with a vision-capable model can still
    // retrieve the image this turn couldn't include.
    const toolKeyMatch = notation.match(/toolKey:\s*"([^"]+)"/);
    expect(toolKeyMatch, 'excluded notation must embed a real toolKey').to.not.equal(null);
    expect(getToolContentEntry('thread-1', toolKeyMatch![1]!)).to.deep.equal({
      kind: 'binary',
      attachmentId: id,
    });
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
    // don't — the fallback path resolveAttachmentForTurn exercises when
    // getArtifact() returns undefined despite a valid meta lookup.
    unlinkSync(join(dir, id, meta.originalFilename));

    const result = await resolveAttachmentForTurn(id, 'thread-1', 'p', 'm', async () => true);

    expect(result?.record).to.deep.equal({
      id,
      filename: 'photo.png',
      mimeType: 'image/png',
      included: false,
      exclusionReason: 'artifact_missing',
    });
    expect(result?.injection.kind).to.equal('excluded');
    expect((result?.injection as { notation: string }).notation).to.include('no longer available');
  });

  it('builds a multimodal injection for a vision-required attachment when the model supports vision', async () => {
    const original = Buffer.from('fake-image-bytes');
    const id = await storeArtifact({
      mimeType: 'image/png',
      original,
      displayFilename: 'photo.png',
      requiresVision: true,
    });

    const result = await resolveAttachmentForTurn(id, 'thread-1', 'p', 'm', async () => true);

    expect(result?.injection.kind).to.equal('multimodal');
    const injection = result?.injection as {
      kind: 'multimodal';
      imageBlock: { type: 'image'; mimeType: string; data: string };
      followUpNotation: string;
    };
    expect(injection.imageBlock).to.deep.equal({
      type: 'image',
      mimeType: 'image/png',
      data: original.toString('base64'),
    });
    expect(injection.followUpNotation).to.include('get_tool_key({ threadId: "thread-1"');
    expect(result?.record).to.deep.equal({
      id,
      filename: 'photo.png',
      mimeType: 'image/png',
      included: true,
    });

    // The toolKey embedded in the follow-up notation must resolve to a
    // binary pointer at the real attachmentId, so a later turn can re-fetch
    // the same image via get_tool_key.
    const toolKeyMatch = injection.followUpNotation.match(/toolKey:\s*"([^"]+)"/);
    expect(toolKeyMatch, 'followUpNotation must embed a real toolKey').to.not.equal(null);
    expect(getToolContentEntry('thread-1', toolKeyMatch![1]!)).to.deep.equal({
      kind: 'binary',
      attachmentId: id,
    });
  });

  it('mints a different toolKey each time the same attachment is resolved again', async () => {
    const id = await storeArtifact({
      mimeType: 'image/png',
      original: Buffer.from('fake-image-bytes'),
      displayFilename: 'photo.png',
      requiresVision: true,
    });

    const first = await resolveAttachmentForTurn(id, 'thread-1', 'p', 'm', async () => true);
    const second = await resolveAttachmentForTurn(id, 'thread-1', 'p', 'm', async () => true);

    const firstNotation = (first?.injection as { followUpNotation: string }).followUpNotation;
    const secondNotation = (second?.injection as { followUpNotation: string }).followUpNotation;
    const firstKey = firstNotation.match(/toolKey:\s*"([^"]+)"/)![1];
    const secondKey = secondNotation.match(/toolKey:\s*"([^"]+)"/)![1];

    expect(firstKey).to.not.equal(secondKey);
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
    const result = await resolveAttachmentForTurn(id, 'thread-1', 'p', 'm', async () => {
      checkVisionCalled = true;
      return false;
    });

    expect(checkVisionCalled).to.equal(false);
    expect(result?.injection).to.deep.equal({
      kind: 'text',
      notation: '---\nAttached file "notes.txt":\nthe extracted notes',
    });
    expect(result?.record).to.deep.equal({
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

    const result = await resolveAttachmentForTurn(id, threadId, 'p', 'm');

    expect(result?.injection.kind).to.equal('text');
    const notation = (result?.injection as { notation: string }).notation;
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

    const result = await resolveAttachmentForTurn(id, 'thread-1', 'p', 'm');

    expect(result?.injection).to.deep.equal({
      kind: 'text',
      notation: `---\nAttached file "exact.txt":\n${exactText}`,
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
