import { describe, it } from 'mocha';
import { expect } from 'chai';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import { extractLatestTurnText, drainPendingWikiUpdates } from './after-agent.js';

describe('agents/after-agent', () => {
  describe('extractLatestTurnText()', () => {
    it('returns an empty string when there are no human messages', () => {
      const messages = [new SystemMessage('you are a helpful assistant'), new AIMessage('hi')];
      expect(extractLatestTurnText(messages)).to.equal('');
    });

    it('returns an empty string for an empty message list', () => {
      expect(extractLatestTurnText([])).to.equal('');
    });

    it('includes the last human message and everything after it', () => {
      const messages = [
        new HumanMessage('what is rust'),
        new AIMessage('a systems programming language'),
        new HumanMessage('I work at Acme Corp as a backend engineer'),
        new AIMessage('got it, noted'),
      ];
      const result = extractLatestTurnText(messages);
      expect(result).to.include('I work at Acme Corp as a backend engineer');
      expect(result).to.include('got it, noted');
    });

    it('excludes messages from prior turns', () => {
      const messages = [
        new HumanMessage('what is rust'),
        new AIMessage('a systems programming language'),
        new HumanMessage('I work at Acme Corp'),
      ];
      const result = extractLatestTurnText(messages);
      expect(result).to.not.include('what is rust');
      expect(result).to.not.include('systems programming language');
      expect(result).to.include('I work at Acme Corp');
    });
  });

  describe('drainPendingWikiUpdates()', () => {
    it('returns an empty array for a thread with no pending events', () => {
      expect(drainPendingWikiUpdates('unknown-thread-id')).to.deep.equal([]);
    });

    it('returns an empty array on a second drain (no double-delivery)', () => {
      const threadId = 'drain-test-thread';
      expect(drainPendingWikiUpdates(threadId)).to.deep.equal([]);
      expect(drainPendingWikiUpdates(threadId)).to.deep.equal([]);
    });
  });
});
