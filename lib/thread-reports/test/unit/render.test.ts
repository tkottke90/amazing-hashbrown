import { describe, it } from 'mocha';
import { expect } from 'chai';
import { renderThreadReportHtml } from '../../src/render.js';
import type { ThreadReportData } from '../../src/types.js';

function fixture(): ThreadReportData {
  return {
    threadId: 'thread-abc-123',
    generatedAt: '2026-07-18T12:00:00.000Z',
    thread: {
      id: 'thread-abc-123',
      title: 'Minecraft chat',
      createdAt: '2026-07-18T10:00:00.000Z',
      updatedAt: '2026-07-18T10:05:00.000Z',
      forkedFromThreadId: null,
      forkedFromSeq: null,
      messages: [
        {
          id: 'u1',
          threadId: 'thread-abc-123',
          seq: 1,
          kind: 'user',
          status: null,
          retryOf: null,
          checkpointId: null,
          payload: { content: 'I like **Minecraft**', sentAt: '2026-07-18T10:00:00.000Z' },
          createdAt: '2026-07-18T10:00:00.000Z',
          updatedAt: '2026-07-18T10:00:00.000Z',
        },
        {
          id: 'a1',
          threadId: 'thread-abc-123',
          seq: 2,
          kind: 'assistant',
          status: 'done',
          retryOf: null,
          checkpointId: null,
          payload: { content: 'Cool, noted!', sentAt: '2026-07-18T10:00:01.000Z' },
          createdAt: '2026-07-18T10:00:01.000Z',
          updatedAt: '2026-07-18T10:00:01.000Z',
        },
      ],
    },
    stats: {
      turnCount: 1,
      toolCallCount: 0,
      mostPopularTool: null,
      failureCount: 0,
      wikiWriteCount: 1,
    },
    timeline: [
      {
        kind: 'wiki_update',
        seq: 3,
        pageTitle: 'Minecraft',
        pageKind: 'entity',
        wikiName: 'user',
        at: '2026-07-18T10:00:02.000Z',
      },
    ],
  };
}

describe('render/renderThreadReportHtml', () => {
  it('produces a well-formed, self-contained HTML document with the expected content', async () => {
    const html = await renderThreadReportHtml(fixture());

    expect(html).to.include('<!DOCTYPE html>');
    expect(html).to.include('<style>'); // inline CSS, no external stylesheet link
    expect(html).to.not.include('<link');
    expect(html).to.not.include('http://');
    expect(html).to.not.include('https://');

    expect(html).to.include('thread-abc-123');
    expect(html).to.include('Minecraft chat');
    // The markdown filter should have converted **Minecraft** to real <strong> markup.
    expect(html).to.include('<strong>Minecraft</strong>');
    expect(html).to.include('Cool, noted!');
    // The timeline's wiki_update marker.
    expect(html).to.include('Wrote/updated');
    expect(html).to.include('<code>user</code> wiki');
  });
});
