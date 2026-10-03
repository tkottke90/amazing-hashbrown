import { describe, it } from 'mocha';
import { expect } from 'chai';
import { ChatSSEEventSchema, UserMessageAttachmentSchema } from '../../src/chat/sse-events.js';

describe('chat/UserMessageAttachmentSchema', () => {
  it('accepts an attachment with included omitted, the optimistic-bubble shape before a turn resolves [unit]', () => {
    const parsed = UserMessageAttachmentSchema.safeParse({
      id: 'att-1',
      filename: 'notes.txt',
      mimeType: 'text/plain',
    });
    expect(parsed.success).to.equal(true);
  });

  it('rejects an attachment missing its id, since nothing downstream can fetch it [unit]', () => {
    const parsed = UserMessageAttachmentSchema.safeParse({
      filename: 'notes.txt',
      mimeType: 'text/plain',
    });
    expect(parsed.success).to.equal(false);
  });

  it('rejects an unknown exclusionReason, so the UI never has to guess at new copy [unit]', () => {
    const parsed = UserMessageAttachmentSchema.safeParse({
      id: 'att-1',
      filename: 'photo.png',
      mimeType: 'image/png',
      included: false,
      exclusionReason: 'too_large',
    });
    expect(parsed.success).to.equal(false);
  });
});

describe('chat/ChatSSEEventSchema — stream_done attachments', () => {
  it('accepts a stream_done event carrying a multi-item attachments array [unit]', () => {
    const event = {
      type: 'stream_done',
      durationMs: 1200,
      attachments: [
        { id: 'att-1', filename: 'photo.png', mimeType: 'image/png', included: true },
        {
          id: 'att-2',
          filename: 'scan.pdf',
          mimeType: 'application/pdf',
          included: false,
          exclusionReason: 'vision_unsupported',
        },
      ],
    };
    const parsed = ChatSSEEventSchema.safeParse(event);
    expect(parsed.success).to.equal(true);
    expect(parsed.data).to.deep.equal(event);
  });

  it('accepts a stream_done event with attachments omitted, so a turn with none still round-trips [unit]', () => {
    const parsed = ChatSSEEventSchema.safeParse({ type: 'stream_done', durationMs: 1200 });
    expect(parsed.success).to.equal(true);
  });
});

describe('chat/ChatSSEEventSchema — stream_error attachments', () => {
  it('accepts a stream_error event carrying attachments, since resolution happens before the turn can fail [unit]', () => {
    const event = {
      type: 'stream_error',
      error: 'Context size has been exceeded',
      attachments: [{ id: 'att-1', filename: 'notes.txt', mimeType: 'text/plain', included: true }],
    };
    const parsed = ChatSSEEventSchema.safeParse(event);
    expect(parsed.success).to.equal(true);
    expect(parsed.data).to.deep.equal(event);
  });

  it('accepts a stream_error event with attachments omitted, for back-compat with turns that never had any [unit]', () => {
    const parsed = ChatSSEEventSchema.safeParse({ type: 'stream_error', error: 'boom' });
    expect(parsed.success).to.equal(true);
  });
});
