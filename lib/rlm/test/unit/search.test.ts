import { describe, it } from "mocha";
import { expect } from "chai";
import { CorpusIndex } from "../../src/search.js";
import { NoOpEmbeddingAdapter } from "../../src/types.js";

// Deterministic fake embedding: encodes line index as a one-hot vector
function makeVec(dim: number, hotIndex: number): number[] {
  return Array.from({ length: dim }, (_, i) => (i === hotIndex % dim ? 1 : 0));
}

const FAKE_DIM = 8;
const lines = [
  "Section A: apple and oranges",
  "Section A continued: more fruit",
  "Section B: programming concepts",
  "Section B continued: algorithms",
  "Section C: history of Rome",
];

describe("CorpusIndex", () => {
  it("builds an empty index from a NoOpEmbeddingAdapter", async () => {
    const index = await CorpusIndex.build(lines, new NoOpEmbeddingAdapter());
    // No-op returns zero vectors; search should still not throw
    const results = index.search(makeVec(FAKE_DIM, 0), 3);
    expect(results).to.be.an("array");
  });

  it("ranks chunks by cosine similarity", async () => {
    // Fake adapter: chunk i gets a one-hot vector at position i % FAKE_DIM
    let chunkIndex = 0;
    const fakeAdapter = {
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map(() => makeVec(FAKE_DIM, chunkIndex++));
      },
    };

    const index = await CorpusIndex.build(lines, fakeAdapter);

    // Query vec matches chunk 0 (hot at position 0)
    const queryVec = makeVec(FAKE_DIM, 0);
    const results = index.search(queryVec, 1);
    expect(results).to.have.length(1);
    // The result with highest cosine should be chunk 0 (startLine 1)
    expect(results[0]!.startLine).to.equal(1);
  });

  it("returns at most topK results", async () => {
    const fakeAdapter = {
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map((_, i) => makeVec(FAKE_DIM, i));
      },
    };
    const index = await CorpusIndex.build(lines, fakeAdapter);
    const results = index.search(makeVec(FAKE_DIM, 0), 2);
    expect(results.length).to.be.at.most(2);
  });

  it("each chunk has correct startLine and endLine", async () => {
    const fakeAdapter = {
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map(() => []);
      },
    };
    const index = await CorpusIndex.build(lines, fakeAdapter);
    const results = index.search([], 10);
    for (const r of results) {
      expect(r.startLine).to.be.at.least(1);
      expect(r.endLine).to.be.at.least(r.startLine);
    }
  });
});
