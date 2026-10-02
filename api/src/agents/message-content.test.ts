import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { MessageContent } from '@langchain/core/messages';
import { getMessageText } from './message-content.js';

enum TestTypes {
  UNIT = '[unit]',
}

describe('agents/message-content', () => {
  it(`returns the string unchanged when content is already a plain string ${TestTypes.UNIT}`, () => {
    expect(getMessageText('base prompt')).to.equal('base prompt');
  });

  it(`joins the text blocks of a structured content array in order ${TestTypes.UNIT}`, () => {
    const content: MessageContent = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ];
    expect(getMessageText(content)).to.equal('first\nsecond');
  });

  it(`drops a non-text block (e.g. an attached image) and keeps only the readable text ${TestTypes.UNIT}`, () => {
    const content = [
      { type: 'text', text: 'describe this image' },
      { type: 'image', mimeType: 'image/png', data: 'YmFzZTY0' },
    ] as unknown as MessageContent;
    expect(getMessageText(content)).to.equal('describe this image');
  });

  it(`returns an empty string when the array has no text blocks ${TestTypes.UNIT}`, () => {
    const content = [
      { type: 'image', mimeType: 'image/png', data: 'YmFzZTY0' },
    ] as unknown as MessageContent;
    expect(getMessageText(content)).to.equal('');
  });
});
