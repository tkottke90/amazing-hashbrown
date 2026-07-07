import { OpenAIEmbeddingProvider } from './openai.js';
import type { EmbeddingAdapter } from '@tkottke90/inference-adapter';

export interface OllamaEmbeddingOptions {
  /** Ollama server base URL. Default: 'http://localhost:11434/v1'. */
  baseUrl?: string;
  /** Ollama embedding model name. Default: 'nomic-embed-text'. */
  model?: string;
}

/**
 * Embedding provider using a local Ollama instance via its OpenAI-compatible API.
 * Requires the `openai` package to be installed and Ollama running locally.
 */
export class OllamaEmbeddingProvider implements EmbeddingAdapter {
  private readonly inner: OpenAIEmbeddingProvider;

  constructor(opts: OllamaEmbeddingOptions = {}) {
    this.inner = new OpenAIEmbeddingProvider({
      apiKey: 'ollama',
      baseURL: opts.baseUrl ?? 'http://localhost:11434/v1',
      model: opts.model ?? 'nomic-embed-text',
    });
  }

  get model(): string {
    return this.inner.model;
  }

  embed(texts: string[]): Promise<number[][]> {
    return this.inner.embed(texts);
  }
}
