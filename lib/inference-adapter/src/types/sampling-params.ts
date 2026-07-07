export interface BaseSamplingParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

/** Extended params for backends that support nucleus sampling via topK (Ollama, Anthropic). */
export interface SamplingParamsWithTopK extends BaseSamplingParams {
  topK?: number;
}
