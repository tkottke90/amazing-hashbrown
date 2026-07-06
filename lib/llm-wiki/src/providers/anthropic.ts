import type { EmbeddingProvider } from '../types.js';

export interface AnthropicEmbeddingOptions {
  apiKey?: string;
  /** Voyage AI model name. Default: 'voyage-3'. */
  model?: string;
}

/**
 * Embedding provider using Voyage AI (Anthropic's embedding service).
 * Requires the `voyageai` package to be installed.
 */
export class AnthropicEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  private readonly apiKey?: string;

  constructor(opts: AnthropicEmbeddingOptions = {}) {
    this.model = opts.model ?? 'voyage-3';
    this.apiKey = opts.apiKey ?? process.env['VOYAGE_API_KEY'];
  }

  async embed(texts: string[]): Promise<number[][]> {
    let VoyageAIClient: new (opts: { apiKey?: string }) => { embed(req: unknown): Promise<{ data: { data?: { embedding?: number[] }[] } }> };
    try {
      const mod = await import('voyageai');
      VoyageAIClient = (mod as { VoyageAIClient: typeof VoyageAIClient }).VoyageAIClient;
    } catch {
      throw new Error(
        'AnthropicEmbeddingProvider requires the "voyageai" package. Run: npm install voyageai',
      );
    }

    const client = new VoyageAIClient({ apiKey: this.apiKey });
    const response = await client.embed({ input: texts, model: this.model });
    const items = response.data ?? [];
    return items.map((item) => item.embedding ?? []);
  }
}
