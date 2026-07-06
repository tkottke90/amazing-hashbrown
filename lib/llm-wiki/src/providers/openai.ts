import type { EmbeddingProvider } from '../types.js';

export interface OpenAIEmbeddingOptions {
  apiKey?: string;
  /** OpenAI embedding model name. Default: 'text-embedding-3-small'. */
  model?: string;
  /** Custom base URL — useful for proxies or API-compatible services. */
  baseURL?: string;
}

/**
 * Embedding provider using the OpenAI embeddings API.
 * Requires the `openai` package to be installed.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  private readonly apiKey?: string;
  private readonly baseURL?: string;

  constructor(opts: OpenAIEmbeddingOptions = {}) {
    this.model = opts.model ?? 'text-embedding-3-small';
    this.apiKey = opts.apiKey ?? process.env['OPENAI_API_KEY'];
    this.baseURL = opts.baseURL;
  }

  async embed(texts: string[]): Promise<number[][]> {
    let OpenAI: new (opts: { apiKey?: string; baseURL?: string }) => {
      embeddings: { create(req: { input: string[]; model: string }): Promise<{ data: { embedding: number[] }[] }> };
    };
    try {
      const mod = await import('openai');
      OpenAI = (mod as { default: typeof OpenAI }).default;
    } catch {
      throw new Error(
        'OpenAIEmbeddingProvider requires the "openai" package. Run: npm install openai',
      );
    }

    const client = new OpenAI({ apiKey: this.apiKey, baseURL: this.baseURL });
    const response = await client.embeddings.create({ input: texts, model: this.model });
    return response.data.map((item) => item.embedding);
  }
}
