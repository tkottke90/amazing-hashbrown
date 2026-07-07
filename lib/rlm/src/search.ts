import type { RlmEmbeddingAdapter } from "./types.js";

interface IndexedChunk {
  text: string;
  startLine: number;
  endLine: number;
  vec: number[];
}

const CHUNK_LINES = 30;
const CHUNK_OVERLAP = 5;

export class CorpusIndex {
  private chunks: IndexedChunk[] = [];

  static async build(
    lines: string[],
    adapter: RlmEmbeddingAdapter
  ): Promise<CorpusIndex> {
    const index = new CorpusIndex();
    const windows: Array<{ text: string; startLine: number; endLine: number }> =
      [];

    for (let i = 0; i < lines.length; i += CHUNK_LINES - CHUNK_OVERLAP) {
      const start = i;
      const end = Math.min(i + CHUNK_LINES - 1, lines.length - 1);
      const text = lines.slice(start, end + 1).join("\n");
      windows.push({ text, startLine: start + 1, endLine: end + 1 });
      if (end === lines.length - 1) break;
    }

    if (windows.length === 0) return index;

    const vecs = await adapter.embed(windows.map((w) => w.text));
    index.chunks = windows.map((w, i) => ({
      ...w,
      vec: vecs[i] ?? [],
    }));

    return index;
  }

  search(queryVec: number[], topK: number): IndexedChunk[] {
    if (this.chunks.length === 0) return [];
    return this.chunks
      .map((chunk) => ({
        chunk,
        score: cosineSimilarity(queryVec, chunk.vec),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((r) => r.chunk);
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
