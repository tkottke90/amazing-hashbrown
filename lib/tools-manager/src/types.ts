import type { z } from 'zod';

export type { ToolDefinition, ToolCall } from '@tkottke90/inference-adapter';

export interface RegisteredTool {
  name: string;
  description: string;
  parameters: z.ZodType;
  source: 'builtin' | 'mcp';
  mcpServer?: string;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

export interface McpStdioConfig {
  transport?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  restart?: { enabled?: boolean; maxAttempts?: number; delayMs?: number };
}

export interface McpHttpConfig {
  transport: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
  reconnect?: { enabled?: boolean; maxAttempts?: number; delayMs?: number };
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}
