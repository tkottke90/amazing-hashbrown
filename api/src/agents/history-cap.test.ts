import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import { estimateTokens } from '@tkottke90/llm-common-types/tokens';
import { configManager } from '../config/env.js';
import {
  capHistoryForPrompt,
  getHistoryTokenBudget,
  DEFAULT_HISTORY_BUDGET_FRACTION,
} from './history-cap.js';

describe('agents/history-cap', () => {
  afterEach(() => {
    configManager.set('chat', {});
  });

  describe('capHistoryForPrompt() [unit]', () => {
    it('returns an empty kept array and zero omittedCount for empty input', () => {
      expect(capHistoryForPrompt([], 1000)).to.deep.equal({ kept: [], omittedCount: 0 });
    });

    it('keeps everything, in original order, when it all fits under budget', () => {
      const items = ['first', 'second', 'third'];
      const budget = items.reduce((sum, i) => sum + estimateTokens(i), 0);
      expect(capHistoryForPrompt(items, budget)).to.deep.equal({ kept: items, omittedCount: 0 });
    });

    it('drops the oldest items first once the budget is exceeded', () => {
      const items = ['oldest', 'middle', 'newest'];
      const budget = estimateTokens('newest'); // fits only the newest
      const result = capHistoryForPrompt(items, budget);
      expect(result.kept).to.deep.equal(['newest']);
      expect(result.omittedCount).to.equal(2);
    });

    it('returns kept: [] with the full omittedCount when a single item alone exceeds the budget', () => {
      const result = capHistoryForPrompt(['x'.repeat(1000)], 1);
      expect(result.kept).to.deep.equal([]);
      expect(result.omittedCount).to.equal(1);
    });

    it('keeps an item exactly at the budget boundary', () => {
      const items = ['older', 'exact-fit'];
      const budget = estimateTokens('exact-fit'); // covers exactly the last item
      const result = capHistoryForPrompt(items, budget);
      expect(result.kept).to.deep.equal(['exact-fit']);
      expect(result.omittedCount).to.equal(1);
    });

    it('keeps items in original chronological order even though it walks backward internally', () => {
      const items = ['a', 'b', 'c', 'd'];
      const budget = items.slice(1).reduce((sum, i) => sum + estimateTokens(i), 0); // fits b, c, d
      const result = capHistoryForPrompt(items, budget);
      expect(result.kept).to.deep.equal(['b', 'c', 'd']);
      expect(result.omittedCount).to.equal(1);
    });
  });

  describe('getHistoryTokenBudget() [unit]', () => {
    it('derives from env.chat.contextWindow.maxTokens using the default fraction', () => {
      configManager.set('chat', { contextWindow: { maxTokens: 10000 } });
      expect(getHistoryTokenBudget()).to.equal(Math.floor(10000 * DEFAULT_HISTORY_BUDGET_FRACTION));
    });

    it('applies a custom fraction override instead of the default', () => {
      configManager.set('chat', { contextWindow: { maxTokens: 10000 } });
      expect(getHistoryTokenBudget(0.5)).to.equal(5000);
    });

    it('falls back to a maxTokens of 32000 when env.chat.contextWindow is absent', () => {
      configManager.set('chat', {});
      expect(getHistoryTokenBudget()).to.equal(Math.floor(32000 * DEFAULT_HISTORY_BUDGET_FRACTION));
    });
  });
});
