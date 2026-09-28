import { describe, it } from 'mocha';
import { expect } from 'chai';
import { wikiWriteDeniedMessage, wikiWriteForbiddenMessage } from './wiki-write-guard.js';

describe('agents/tools/wiki-write-guard', () => {
  describe('wikiWriteForbiddenMessage()', () => {
    it('names both the rejected wiki and the allowed wiki', () => {
      expect(wikiWriteForbiddenMessage('other-wiki', 'test-wiki')).to.equal(
        'This workspace is restricted to writing wiki "test-wiki" — ' +
          '"other-wiki" is not allowed here — use wiki "test-wiki" instead.',
      );
    });
  });

  describe('wikiWriteDeniedMessage()', () => {
    it('keeps the existing "use wiki X instead" text for a locked denial [unit]', () => {
      // wwrite-006/007 evals depend on this exact steering text.
      expect(
        wikiWriteDeniedMessage({
          status: 'wiki_forbidden',
          wikiId: 'other-wiki',
          reason: 'locked',
          allowedWikiId: 'test-wiki',
        }),
      ).to.equal(wikiWriteForbiddenMessage('other-wiki', 'test-wiki'));
    });

    it('tells the agent to pick another wiki or ask when the target belongs to another workspace [unit]', () => {
      const msg = wikiWriteDeniedMessage({
        status: 'wiki_forbidden',
        wikiId: 'video-streaming',
        reason: 'owned-by-another-workspace',
      });
      expect(msg).to.contain('"video-streaming" belongs to another workspace');
      expect(msg).to.contain('ask the user');
    });

    it('explains that writes are unavailable when the workspace could not be determined [unit]', () => {
      expect(
        wikiWriteDeniedMessage({ status: 'wiki_forbidden', wikiId: 'user', reason: 'unresolved' }),
      ).to.contain('could not be determined');
    });
  });
});
