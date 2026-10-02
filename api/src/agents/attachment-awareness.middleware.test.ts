import { describe, it } from 'mocha';
import { expect } from 'chai';
import { HumanMessage, AIMessage, type BaseMessage } from '@langchain/core/messages';
import { createAttachmentAwarenessMiddleware } from './attachment-awareness.middleware.js';
import type { AttachmentInjection } from './attachment-resolution.js';

function makeState(messages: BaseMessage[]): { messages: BaseMessage[] } {
  return { messages };
}

function makeRuntime(attachmentInjections?: AttachmentInjection[]) {
  return { configurable: attachmentInjections ? { attachmentInjections } : {} };
}

interface BeforeAgentResult {
  messages: BaseMessage[];
}

async function callBeforeAgent(
  middleware: ReturnType<typeof createAttachmentAwarenessMiddleware>,
  state: { messages: BaseMessage[] },
  runtime: ReturnType<typeof makeRuntime>,
): Promise<BeforeAgentResult | undefined> {
  const hook = middleware.beforeAgent;
  if (typeof hook !== 'function') throw new Error('test setup error: no beforeAgent hook');
  return hook(state, runtime) as Promise<BeforeAgentResult | undefined>;
}

describe('agents/attachment-awareness.middleware [unit]', () => {
  it('returns undefined when there is no attachmentInjections in configurable', async () => {
    const middleware = createAttachmentAwarenessMiddleware();
    const result = await callBeforeAgent(
      middleware,
      makeState([new HumanMessage('hello')]),
      makeRuntime(undefined),
    );
    expect(result).to.equal(undefined);
  });

  it('returns undefined for an empty attachmentInjections array', async () => {
    const middleware = createAttachmentAwarenessMiddleware();
    const result = await callBeforeAgent(
      middleware,
      makeState([new HumanMessage('hello')]),
      makeRuntime([]),
    );
    expect(result).to.equal(undefined);
  });

  it('returns undefined when there is no human message to rewrite', async () => {
    const middleware = createAttachmentAwarenessMiddleware();
    const result = await callBeforeAgent(
      middleware,
      makeState([new AIMessage('hi there')]),
      makeRuntime([{ kind: 'text', notation: 'some notation' }]),
    );
    expect(result).to.equal(undefined);
  });

  it('appends a text injection to the last human message, preserving its id', async () => {
    const middleware = createAttachmentAwarenessMiddleware();
    const original = new HumanMessage({ content: 'what does this say?', id: 'msg-1' });
    const result = await callBeforeAgent(
      middleware,
      makeState([original]),
      makeRuntime([{ kind: 'text', notation: 'Attached file "notes.txt":\nhello' }]),
    );

    expect(result!.messages[0]!.id).to.equal('msg-1');
    expect(result!.messages[0]!.content).to.equal(
      'what does this say?\n\nAttached file "notes.txt":\nhello',
    );
  });

  it('appends an excluded notation the same way a text injection would', async () => {
    const middleware = createAttachmentAwarenessMiddleware();
    const original = new HumanMessage({ content: 'look at this', id: 'msg-2' });
    const result = await callBeforeAgent(
      middleware,
      makeState([original]),
      makeRuntime([{ kind: 'excluded', notation: '[could not be included]' }]),
    );

    expect(result!.messages[0]!.content).to.equal('look at this\n\n[could not be included]');
  });

  it('replaces the last human message content with a text+image array for a single multimodal injection', async () => {
    const middleware = createAttachmentAwarenessMiddleware();
    const original = new HumanMessage({ content: 'look at this', id: 'msg-3' });
    const result = await callBeforeAgent(
      middleware,
      makeState([original]),
      makeRuntime([
        {
          kind: 'multimodal',
          imageBlock: { type: 'image', mimeType: 'image/png', data: 'YmFzZTY0' },
        },
      ]),
    );

    expect(result!.messages[0]!.id).to.equal('msg-3');
    expect(result!.messages[0]!.content).to.deep.equal([
      { type: 'text', text: 'look at this' },
      { type: 'image', mimeType: 'image/png', data: 'YmFzZTY0' },
    ]);
  });

  it('combines several multimodal injections into one text block followed by every image block, in order', async () => {
    const middleware = createAttachmentAwarenessMiddleware();
    const original = new HumanMessage({ content: 'compare these', id: 'msg-4' });
    const result = await callBeforeAgent(
      middleware,
      makeState([original]),
      makeRuntime([
        { kind: 'multimodal', imageBlock: { type: 'image', mimeType: 'image/png', data: 'AAA' } },
        { kind: 'multimodal', imageBlock: { type: 'image', mimeType: 'image/jpeg', data: 'BBB' } },
      ]),
    );

    expect(result!.messages[0]!.content).to.deep.equal([
      { type: 'text', text: 'compare these' },
      { type: 'image', mimeType: 'image/png', data: 'AAA' },
      { type: 'image', mimeType: 'image/jpeg', data: 'BBB' },
    ]);
  });

  it('keeps content a plain string when every injection is text/excluded (no images), concatenated in order', async () => {
    const middleware = createAttachmentAwarenessMiddleware();
    const original = new HumanMessage({ content: 'two files', id: 'msg-5' });
    const result = await callBeforeAgent(
      middleware,
      makeState([original]),
      makeRuntime([
        { kind: 'text', notation: 'Attached file "a.txt":\nfirst' },
        { kind: 'excluded', notation: '[could not include b.pdf]' },
      ]),
    );

    expect(result!.messages[0]!.content).to.equal(
      'two files\n\nAttached file "a.txt":\nfirst\n\n[could not include b.pdf]',
    );
  });

  it('puts every image block after one combined text block for a mix of text and multimodal injections', async () => {
    const middleware = createAttachmentAwarenessMiddleware();
    const original = new HumanMessage({ content: 'mixed batch', id: 'msg-6' });
    const result = await callBeforeAgent(
      middleware,
      makeState([original]),
      makeRuntime([
        { kind: 'text', notation: 'Attached file "notes.txt":\nhello' },
        { kind: 'multimodal', imageBlock: { type: 'image', mimeType: 'image/png', data: 'AAA' } },
      ]),
    );

    expect(result!.messages[0]!.content).to.deep.equal([
      { type: 'text', text: 'mixed batch\n\nAttached file "notes.txt":\nhello' },
      { type: 'image', mimeType: 'image/png', data: 'AAA' },
    ]);
  });

  it('only rewrites the last human message when several messages are present', async () => {
    const middleware = createAttachmentAwarenessMiddleware();
    const first = new HumanMessage({ content: 'first turn', id: 'msg-1' });
    const ai = new AIMessage('first reply');
    const second = new HumanMessage({ content: 'second turn', id: 'msg-2' });
    const result = await callBeforeAgent(
      middleware,
      makeState([first, ai, second]),
      makeRuntime([{ kind: 'text', notation: 'notation' }]),
    );

    expect(result!.messages[0]).to.equal(first);
    expect(result!.messages[1]).to.equal(ai);
    expect(result!.messages[2]!.content).to.equal('second turn\n\nnotation');
  });
});
