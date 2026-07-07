import type { EmbeddingProvider } from '../types.js';

/** Returns zero vectors — useful for tests or wikis where semantic search is disabled. */
export class NullEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  private readonly dimension: number;

  constructor(dimension = 1536) {
    this.dimension = dimension;
    this.model = `null-${dimension}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => new Array<number>(this.dimension).fill(0));
  }
}
