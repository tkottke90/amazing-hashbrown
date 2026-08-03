import { OllamaEmbeddings } from '@langchain/ollama';
import { OpenAIEmbeddings } from '@langchain/openai';
import type { EmbeddingAdapter } from '@tkottke90/inference-adapter';

class OllamaEmbeddingAdapter implements EmbeddingAdapter {
  readonly model: string;
  private readonly embeddings: OllamaEmbeddings;

  constructor(model: string, baseUrl: string) {
    this.model = model;
    this.embeddings = new OllamaEmbeddings({ model, baseUrl });
  }

  async embed(texts: string[]): Promise<number[][]> {
    return this.embeddings.embedDocuments(texts);
  }
}

class OpenAIEmbeddingAdapter implements EmbeddingAdapter {
  readonly model: string;
  private readonly embeddings: OpenAIEmbeddings;

  constructor(model: string, apiKey?: string) {
    this.model = model;
    this.embeddings = new OpenAIEmbeddings({ model, openAIApiKey: apiKey });
  }

  async embed(texts: string[]): Promise<number[][]> {
    return this.embeddings.embedDocuments(texts);
  }
}

export type EmbeddingsConfig = {
  enabled: boolean;
  type?: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
};

export function createEmbeddingAdapter(config: EmbeddingsConfig | undefined): EmbeddingAdapter | undefined {
  if (!config?.enabled) return undefined;
  switch (config.type ?? 'ollama') {
    case 'ollama':
      return new OllamaEmbeddingAdapter(config.model, config.baseUrl ?? 'http://localhost:11434');
    case 'openai':
      return new OpenAIEmbeddingAdapter(config.model, config.apiKey);
    default:
      return undefined;
  }
}
