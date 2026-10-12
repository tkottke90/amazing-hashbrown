import { strict as assert } from 'node:assert';
import { describe, it } from 'mocha';
import type { Embeddings } from '@langchain/core/embeddings';
import { runSemantic } from '../../../src/executors/semantic.js';
import type { SemanticScenario } from '../../../src/schemas.js';

function makeScenario(overrides: Partial<SemanticScenario> = {}): SemanticScenario {
  return {
    id: 'x',
    name: 'x',
    purpose: 'x',
    input: 'x',
    type: 'semantic',
    expectedSimilarTo: 'expected text',
    minSimilarity: 0.75,
    ...overrides,
  };
}

// runSemantic calls Promise.all([embedQuery(actualOutput), embedQuery(expected)])
// — this fake returns vecForActualOutput for the first call and
// vecForExpected for the second, recording the raw text each call received.
function makeFakeEmbeddings(
  vecForActualOutput: number[],
  vecForExpected: number[],
): { embeddings: Embeddings; calls: string[] } {
  const calls: string[] = [];
  let callIndex = 0;
  const embeddings = {
    embedQuery: async (text: string) => {
      calls.push(text);
      const vec = callIndex === 0 ? vecForActualOutput : vecForExpected;
      callIndex += 1;
      return vec;
    },
  } as unknown as Embeddings;
  return { embeddings, calls };
}

describe('runSemantic', () => {
  it('calls embedQuery once for actualOutput and once for expectedSimilarTo, in that order [unit]', async () => {
    const { embeddings, calls } = makeFakeEmbeddings([1, 0], [1, 0]);
    await runSemantic(
      makeScenario({ expectedSimilarTo: 'the expected text' }),
      'the actual text',
      embeddings,
    );
    assert.deepEqual(calls, ['the actual text', 'the expected text']);
  });

  it('returns similarity 1 for identical vectors [unit]', async () => {
    const { embeddings } = makeFakeEmbeddings([1, 2, 3], [1, 2, 3]);
    const result = await runSemantic(makeScenario(), 'a', embeddings);
    assert.equal(result.similarity, 1);
  });

  it('returns similarity 0 for orthogonal vectors [unit]', async () => {
    const { embeddings } = makeFakeEmbeddings([1, 0], [0, 1]);
    const result = await runSemantic(makeScenario(), 'a', embeddings);
    assert.equal(result.similarity, 0);
  });

  it('computes a non-trivial cosine similarity correctly [unit]', async () => {
    // cos([1,0],[1,1]) = 1/sqrt(2)
    const { embeddings } = makeFakeEmbeddings([1, 0], [1, 1]);
    const result = await runSemantic(makeScenario(), 'a', embeddings);
    assert.ok(Math.abs(result.similarity - 1 / Math.sqrt(2)) < 1e-9);
  });

  it('returns similarity 0 when a vector is all zeros (zero-length edge case) [unit]', async () => {
    const { embeddings } = makeFakeEmbeddings([0, 0], [1, 1]);
    const result = await runSemantic(makeScenario(), 'a', embeddings);
    assert.equal(result.similarity, 0);
  });

  it('returns similarity 0 when embeddings return empty vectors [unit]', async () => {
    const { embeddings } = makeFakeEmbeddings([], []);
    const result = await runSemantic(makeScenario(), 'a', embeddings);
    assert.equal(result.similarity, 0);
  });

  it('sets threshold to scenario.minSimilarity regardless of the similarity result [unit]', async () => {
    const { embeddings } = makeFakeEmbeddings([0, 1], [1, 0]); // orthogonal → similarity 0
    const result = await runSemantic(makeScenario({ minSimilarity: 0.42 }), 'a', embeddings);
    assert.equal(result.threshold, 0.42);
    assert.equal(result.similarity, 0);
  });

  it('returns type: "semantic" [unit]', async () => {
    const { embeddings } = makeFakeEmbeddings([1, 0], [1, 0]);
    const result = await runSemantic(makeScenario(), 'a', embeddings);
    assert.equal(result.type, 'semantic');
  });
});
