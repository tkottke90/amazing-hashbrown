import type { z } from 'zod';

export type { ToolDefinition, ToolCall } from '@tkottke90/inference-adapter';

export interface RegisteredTool {
  name: string;
  // The tool's real bind/execute identity everywhere in this app — what's
  // actually given to the model as its tool name, and what ToolsManager's
  // internal Maps key by. For a builtin, identical to name (no collision
  // risk — ids are curated). For an MCP tool, server-qualified
  // (mcpDisplayId/mcpBoundName in internal/mcp-naming.ts) so two servers
  // exposing an identically-named tool don't silently overwrite each other.
  boundName: string;
  description: string;
  parameters: z.ZodType;
  source: 'builtin' | 'mcp';
  mcpServer?: string;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

export interface McpStdioConfig {
  transport?: 'stdio';
  enabled?: boolean;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  restart?: { enabled?: boolean; maxAttempts?: number; delayMs?: number };
}

export interface McpHttpConfig {
  transport: 'http' | 'sse';
  enabled?: boolean;
  url: string;
  headers?: Record<string, string>;
  reconnect?: { enabled?: boolean; maxAttempts?: number; delayMs?: number };
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}
