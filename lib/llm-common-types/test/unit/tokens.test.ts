import { describe, it } from 'mocha';
import { expect } from 'chai';
import { estimateTokens } from '../../src/tokens/index.js';

describe('tokens/estimateTokens', () => {
  it('returns 0 for an empty string', () => {
    expect(estimateTokens('')).to.equal(0);
  });

  it('rounds up to the nearest whole token (ceil, not floor)', () => {
    expect(estimateTokens('a')).to.equal(1);
    expect(estimateTokens('abcd')).to.equal(1);
    expect(estimateTokens('abcde')).to.equal(2);
  });

  it('scales linearly with length for longer text', () => {
    const text = 'x'.repeat(400);
    expect(estimateTokens(text)).to.equal(100);
  });
});
