export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolName?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ModelResponse {
  content: string;
  toolCalls: ToolCall[];
  durationMs: number;
}

export interface ModelAdapter {
  complete(
    messages: Message[],
    tools: Tool[],
    config: RLMConfig
  ): Promise<ModelResponse>;
}

export interface RLMConfig {
  model: string;
  maxIterations: number;
  maxResultTokens: number;
  maxSliceLines: number;
  think?: boolean;
  promptAddendum?: string;
  extraTools?: Tool[];
}

export const DEFAULT_CONFIG: RLMConfig = {
  model: "qwen3:8b",
  maxIterations: 10,
  maxResultTokens: 2000,
  maxSliceLines: 200,
  think: false,
};

export type TerminationReason =
  | "final_tool"
  | "not_found_tool"
  | "no_tool_call"
  | "max_iterations";

export interface ToolCallRecord {
  iteration: number;
  tool: string;
  args: Record<string, unknown>;
  resultPreview: string;
  durationMs: number;
}

export interface RLMResult {
  answer: string;
  found: boolean;
  iterations: number;
  toolCallTrace: ToolCallRecord[];
  terminationReason: TerminationReason;
  loopDetectionFired: boolean;
  totalDurationMs: number;
}

export interface StatusSignal {
  phase:
    | "searching"
    | "reading"
    | "summarizing"
    | "querying"
    | "answering"
    | "not_found";
  message: string;
  iteration: number;
  tool?: string;
}

export type StatusCallback = (signal: StatusSignal) => void;

export interface RlmEmbeddingAdapter {
  embed(texts: string[]): Promise<number[][]>;
}

export class NoOpEmbeddingAdapter implements RlmEmbeddingAdapter {
  async embed(_texts: string[]): Promise<number[][]> {
    return [];
  }
}

export interface ProvenanceEntry {
  entityId: string;
  claimText: string;
  sourceDocId: string;
  sourceType: string;
  writtenAt: string;
  supersededBy?: string;
}

export interface RLMCorpus {
  text: string;
  source?: string;
  provenance?: import("./provenance.js").ProvenanceStore;
}
