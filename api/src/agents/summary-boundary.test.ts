import { describe, it } from 'mocha';
import { expect } from 'chai';
import { HumanMessage, AIMessage, trimMessages } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import {
  createSummaryBoundaryMessage,
  isSummaryBoundary,
  boundaryAwareTrim,
} from './summary-boundary.js';

// A simple, deterministic counter — character length stands in for tokens,
// same spirit as chat-agent.test.ts's makeLongMessageHistory (repeated text
// to control size predictably rather than needing a real tokenizer).
function charCount(messages: BaseMessage[]): number {
  return messages.reduce((sum, m) => sum + String(m.content).length, 0);
}

function makeHistory(count: number): BaseMessage[] {
  return Array.from({ length: count }, (_, i) =>
    i % 2 === 0
      ? new HumanMessage(`question number ${i}: `.repeat(10))
      : new AIMessage(`answer number ${i}: `.repeat(10)),
  );
}

describe('agents/summary-boundary', () => {
  describe('createSummaryBoundaryMessage() / isSummaryBoundary()', () => {
    it('tags a message that isSummaryBoundary recognizes', () => {
      const marker = createSummaryBoundaryMessage('.hashbrown/summaries/x.md');
      expect(isSummaryBoundary(marker)).to.equal(true);
    });

    it('does not tag an ordinary AIMessage as a boundary', () => {
      expect(isSummaryBoundary(new AIMessage('just a normal reply'))).to.equal(false);
    });

    it('does not set an id, so LangGraph appends rather than replaces on repeat calls', () => {
      const marker = createSummaryBoundaryMessage('.hashbrown/summaries/x.md');
      expect(marker.id).to.equal(undefined);
    });

    it('keeps the summaryPath recoverable from additional_kwargs', () => {
      const marker = createSummaryBoundaryMessage('.hashbrown/summaries/2026-09-12.md');
      const tag = marker.additional_kwargs['hashbrown'] as { summaryPath?: string };
      expect(tag.summaryPath).to.equal('.hashbrown/summaries/2026-09-12.md');
    });
  });

  describe('boundaryAwareTrim()', () => {
    it('returns messages unchanged when already under budget, even with a boundary present', async () => {
      const messages = makeHistory(10);
      messages.push(createSummaryBoundaryMessage('.hashbrown/summaries/x.md'));
      const total = charCount(messages);

      // Regression test for the bug fixed before implementation: an earlier
      // draft of this algorithm would prune everything before the boundary
      // even when nothing needed trimming for budget reasons at all.
      const trimmed = await boundaryAwareTrim(messages, total, charCount, true);

      expect(trimmed).to.deep.equal(messages);
    });

    it('cuts exactly at the last boundary when the boundary-forward slice fits under budget', async () => {
      const before = makeHistory(20);
      const boundary = createSummaryBoundaryMessage('.hashbrown/summaries/x.md');
      const after = makeHistory(4);
      const messages = [...before, boundary, ...after];

      const sinceBoundary = [boundary, ...after];
      const budget = charCount(sinceBoundary); // fits the boundary-forward slice exactly

      const trimmed = await boundaryAwareTrim(messages, budget, charCount, true);

      expect(trimmed).to.deep.equal(sinceBoundary);
    });

    it('falls back to plain human-boundary trimming when the boundary-forward slice itself exceeds budget', async () => {
      const before = makeHistory(20);
      const boundary = createSummaryBoundaryMessage('.hashbrown/summaries/x.md');
      const after = makeHistory(20);
      const messages = [...before, boundary, ...after];

      // Budget smaller than even [boundary, ...after] alone.
      const budget = Math.floor(charCount([boundary, ...after]) / 2);

      const trimmed = await boundaryAwareTrim(messages, budget, charCount, true);
      const expected = await trimMessages({
        maxTokens: budget,
        strategy: 'last',
        tokenCounter: charCount,
        includeSystem: true,
        allowPartial: false,
        startOn: 'human',
      }).invoke(messages);

      expect(trimmed).to.deep.equal(expected);
    });

    it('falls back to identical trimMessages behavior when no boundary exists at all', async () => {
      const messages = makeHistory(40);
      const budget = Math.floor(charCount(messages) / 3);

      const trimmed = await boundaryAwareTrim(messages, budget, charCount, true);
      const expected = await trimMessages({
        maxTokens: budget,
        strategy: 'last',
        tokenCounter: charCount,
        includeSystem: true,
        allowPartial: false,
        startOn: 'human',
      }).invoke(messages);

      expect(trimmed).to.deep.equal(expected);
    });

    it('uses the last boundary when more than one is present', async () => {
      const firstBoundary = createSummaryBoundaryMessage('.hashbrown/summaries/first.md');
      const middle = makeHistory(10);
      const secondBoundary = createSummaryBoundaryMessage('.hashbrown/summaries/second.md');
      const after = makeHistory(4);
      const messages = [firstBoundary, ...middle, secondBoundary, ...after];

      const sinceSecond = [secondBoundary, ...after];
      const budget = charCount(sinceSecond);

      const trimmed = await boundaryAwareTrim(messages, budget, charCount, true);

      expect(trimmed).to.deep.equal(sinceSecond);
    });
  });
});
