import { describe, it } from 'mocha';
import { expect } from 'chai';
import { ToolMessage } from '@langchain/core/messages';
import { extractToolResultContent } from './tool-output.js';

describe('agents/tool-output', () => {
  describe('extractToolResultContent', () => {
    it('unwraps a ToolMessage instance to its string content', () => {
      const msg = new ToolMessage({
        content: 'Added cross-link from entities/wireguard.md to entities/windows-pc.md.',
        tool_call_id: 'tc1',
        name: 'wiki_add_cross_link',
      });
      expect(extractToolResultContent(msg)).to.equal(
        'Added cross-link from entities/wireguard.md to entities/windows-pc.md.',
      );
    });

    it('unwraps a duck-typed object with a content property', () => {
      const contentBlocks = [{ type: 'text', text: 'hello' }];
      expect(extractToolResultContent({ content: contentBlocks })).to.equal(contentBlocks);
    });

    it('passes a plain string through unchanged', () => {
      expect(extractToolResultContent('5')).to.equal('5');
    });

    it('passes null through unchanged', () => {
      expect(extractToolResultContent(null)).to.equal(null);
    });

    it('passes undefined through unchanged', () => {
      expect(extractToolResultContent(undefined)).to.equal(undefined);
    });

    it('passes an object with no content property through unchanged', () => {
      const value = { foo: 'bar' };
      expect(extractToolResultContent(value)).to.equal(value);
    });
  });
});
