import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type { Connection } from '@langchain/mcp-adapters';
import type { z } from 'zod';
import type { McpConfigFile, RegisteredTool } from '../types.js';

// Minimal interface matching what @langchain/mcp-adapters StructuredToolInterface provides.
// schema is typed as unknown to avoid zod version mismatches between packages.
interface LangChainTool {
  name: string;
  description: string;
  schema: unknown;
  invoke(args: Record<string, unknown>): Promise<unknown>;
}

export function buildMcpClient(config: McpConfigFile): MultiServerMCPClient | null {
  if (Object.keys(config.mcpServers).length === 0) return null;
  // Cast required: our McpServerConfig is a superset of Connection with slightly
  // different field optionality (e.g. transport is optional in our type, required in library)
  return new MultiServerMCPClient(config.mcpServers as unknown as Record<string, Connection>);
}

export async function fetchMcpTools(client: MultiServerMCPClient): Promise<RegisteredTool[]> {
  // initializeConnections returns Map<serverName, StructuredToolInterface[]>
  // which lets us correctly associate each tool with its server
  const serverToTools = await client.initializeConnections();
  const result: RegisteredTool[] = [];
  for (const [serverName, tools] of serverToTools.entries()) {
    for (const tool of tools as unknown as LangChainTool[]) {
      result.push(fromLangChain(tool, serverName));
    }
  }
  return result;
}

function fromLangChain(tool: LangChainTool, serverName: string): RegisteredTool {
  return {
    name: tool.name,
    description: tool.description,
    // Cast required: MCP adapters produce a zod v3 schema at runtime; callers
    // treat this as z.ZodType (v4) which is compatible structurally.
    parameters: tool.schema as z.ZodType,
    source: 'mcp',
    mcpServer: serverName,
    execute: (args) => tool.invoke(args),
  };
}
