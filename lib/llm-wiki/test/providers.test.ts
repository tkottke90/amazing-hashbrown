import { expect } from 'chai';
import { NullEmbeddingProvider } from '../src/providers/null.js';
import { cosineSimilarity } from '../src/internal/embedding-index.js';

describe('NullEmbeddingProvider', () => {
  it('returns zero vectors of the default dimension', async () => {
    const provider = new NullEmbeddingProvider();
    const result = await provider.embed(['hello', 'world']);
    expect(result).to.have.length(2);
    expect(result[0]).to.have.length(1536);
    expect(result[0]!.every((v) => v === 0)).to.be.true;
  });

  it('returns zero vectors of a custom dimension', async () => {
    const provider = new NullEmbeddingProvider(512);
    const result = await provider.embed(['test']);
    expect(result[0]).to.have.length(512);
  });

  it('exposes the correct model string', () => {
    expect(new NullEmbeddingProvider(768).model).to.equal('null-768');
  });

  it('handles an empty input array', async () => {
    const provider = new NullEmbeddingProvider();
    const result = await provider.embed([]);
    expect(result).to.deep.equal([]);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical non-zero vectors', () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).to.be.closeTo(1, 1e-9);
  });

  it('returns 0 for a zero vector', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).to.equal(0);
  });

  it('returns 0 for two zero vectors', () => {
    expect(cosineSimilarity([0, 0], [0, 0])).to.equal(0);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).to.be.closeTo(0, 1e-9);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).to.be.closeTo(-1, 1e-9);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).to.equal(0);
  });

  it('returns 0 for mismatched lengths', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).to.equal(0);
  });
});
