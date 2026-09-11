import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type { Connection } from '@langchain/mcp-adapters';
import type { z } from 'zod';
import type { McpConfigFile, McpServerConfig, RegisteredTool } from '../types.js';

// Minimal interface matching what @langchain/mcp-adapters StructuredToolInterface provides.
// schema is typed as unknown to avoid zod version mismatches between packages.
interface LangChainTool {
  name: string;
  description: string;
  schema: unknown;
  invoke(args: Record<string, unknown>): Promise<unknown>;
}

export function buildMcpClient(config: McpConfigFile): MultiServerMCPClient | null {
  const enabledServers = Object.fromEntries(
    Object.entries(config.mcpServers).filter(([, server]) => server.enabled !== false),
  );
  if (Object.keys(enabledServers).length === 0) return null;
  // Cast required: our McpServerConfig is a superset of Connection with slightly
  // different field optionality (e.g. transport is optional in our type, required in library)
  return new MultiServerMCPClient(enabledServers as unknown as Record<string, Connection>);
}

// Probes a single server config for reachability without touching the live
// client — used both to test an unsaved draft and to re-check an existing
// server on demand. Deliberately doesn't go through buildMcpClient, since
// that filters out enabled:false servers and a disabled draft must still be
// testable before the user turns it on.
export async function testMcpConnection(
  config: McpServerConfig,
): Promise<{ toolCount: number; toolNames: string[] }> {
  const client = new MultiServerMCPClient({
    __test__: config,
  } as unknown as Record<string, Connection>);
  try {
    const tools = await fetchMcpTools(client);
    return { toolCount: tools.length, toolNames: tools.map((t) => t.name) };
  } finally {
    await client.close();
  }
}

export async function fetchMcpTools(client: MultiServerMCPClient): Promise<RegisteredTool[]> {
  // initializeConnections returns Record<serverName, DynamicStructuredTool[]>
  // which lets us correctly associate each tool with its server
  const serverToTools = await client.initializeConnections();
  const result: RegisteredTool[] = [];
  for (const [serverName, tools] of Object.entries(serverToTools)) {
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
