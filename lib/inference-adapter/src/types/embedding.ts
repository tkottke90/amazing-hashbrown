export interface EmbeddingAdapter {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}
