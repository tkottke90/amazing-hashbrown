export type { EmbeddingAdapter } from '@tkottke90/inference-adapter';
export type { EmbeddingAdapter as EmbeddingProvider } from '@tkottke90/inference-adapter';

export { NullEmbeddingProvider } from './null.js';
export type {} from './null.js';

export { AnthropicEmbeddingProvider } from './anthropic.js';
export type { AnthropicEmbeddingOptions } from './anthropic.js';

export { OpenAIEmbeddingProvider } from './openai.js';
export type { OpenAIEmbeddingOptions } from './openai.js';

export { OllamaEmbeddingProvider } from './ollama.js';
export type { OllamaEmbeddingOptions } from './ollama.js';
