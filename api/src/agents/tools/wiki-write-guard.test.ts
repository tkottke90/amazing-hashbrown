import { describe, it } from 'mocha';
import { expect } from 'chai';
import { wikiWriteForbiddenMessage } from './wiki-write-guard.js';

describe('agents/tools/wiki-write-guard', () => {
  describe('wikiWriteForbiddenMessage()', () => {
    it('names both the rejected wiki and the allowed wiki', () => {
      expect(wikiWriteForbiddenMessage('other-wiki', 'test-wiki')).to.equal(
        'This workspace is restricted to writing wiki "test-wiki" — ' +
          '"other-wiki" is not allowed here — use wiki "test-wiki" instead.',
      );
    });
  });
});
