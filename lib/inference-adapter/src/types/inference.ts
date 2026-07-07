import type { z } from 'zod';
import type { Message, ToolCall } from './message.js';
import type { ToolDefinition } from './tool.js';
import type { BaseSamplingParams, SamplingParamsWithTopK } from './sampling-params.js';

export interface BaseCompleteOptions extends BaseSamplingParams {
  tools?: ToolDefinition[];
  schema?: z.ZodType;
}

/** Options for adapters that support topK (Ollama, Anthropic). */
export interface ExtendedCompleteOptions extends SamplingParamsWithTopK {
  tools?: ToolDefinition[];
  schema?: z.ZodType;
}

export interface InferenceResponse {
  message: Message;
  toolCalls?: ToolCall[];
  structured?: unknown;
}

export interface InferenceAdapter {
  invoke(messages: Message[], options?: BaseCompleteOptions): Promise<InferenceResponse>;
}
