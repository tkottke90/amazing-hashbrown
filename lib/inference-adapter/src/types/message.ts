export interface ToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  id?: string;
  content: string;
}

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; results: ToolResult[] };
