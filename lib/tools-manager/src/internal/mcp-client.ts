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

// One MultiServerMCPClient per enabled server, rather than a single client
// covering all of them — this is the isolation boundary that lets one
// unreachable server fail without taking every other server's tools down
// with it (see fetchAllMcpTools below, the actual per-server fetch/catch).
export function buildMcpClient(config: McpConfigFile): Map<string, MultiServerMCPClient> {
  const clients = new Map<string, MultiServerMCPClient>();
  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (server.enabled === false) continue;
    // Cast required: our McpServerConfig is a superset of Connection with slightly
    // different field optionality (e.g. transport is optional in our type, required in library)
    clients.set(
      name,
      new MultiServerMCPClient({ [name]: server } as unknown as Record<string, Connection>),
    );
  }
  return clients;
}

export interface McpCapabilities {
  tools: { name: string; description: string }[];
  resources: { uri: string; name: string; description?: string; mimeType?: string }[];
  resourceTemplates: { uriTemplate: string; name: string; description?: string }[];
}

const TEST_SERVER_NAME = '__test__';

// Probes a single server config for reachability without touching the live
// client — used both to test an unsaved draft and to re-check an existing
// server on demand. Deliberately doesn't go through buildMcpClient, since
// that filters out enabled:false servers and a disabled draft must still be
// testable before the user turns it on.
export async function testMcpConnection(config: McpServerConfig): Promise<McpCapabilities> {
  const client = new MultiServerMCPClient({
    [TEST_SERVER_NAME]: config,
  } as unknown as Record<string, Connection>);
  try {
    const tools = await fetchMcpTools(client);
    const [resourcesByServer, resourceTemplatesByServer] = await Promise.all([
      client.listResources(TEST_SERVER_NAME),
      client.listResourceTemplates(TEST_SERVER_NAME),
    ]);
    return {
      tools: tools.map((t) => ({ name: t.name, description: t.description })),
      resources: resourcesByServer[TEST_SERVER_NAME] ?? [],
      resourceTemplates: resourceTemplatesByServer[TEST_SERVER_NAME] ?? [],
    };
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

export type McpServerStatus = 'connected' | 'unreachable';

// Fetches every server's tools independently, so one server's connection
// failure can't prevent another, healthy server's tools from loading. A
// failing server contributes zero tools and is recorded as 'unreachable' in
// the returned statuses map rather than throwing — the caller (ToolsManager)
// decides what, if anything, to log.
export async function fetchAllMcpTools(
  clients: Map<string, MultiServerMCPClient>,
): Promise<{ tools: RegisteredTool[]; statuses: Map<string, McpServerStatus> }> {
  const tools: RegisteredTool[] = [];
  const statuses = new Map<string, McpServerStatus>();
  for (const [serverName, client] of clients) {
    try {
      tools.push(...(await fetchMcpTools(client)));
      statuses.set(serverName, 'connected');
    } catch {
      statuses.set(serverName, 'unreachable');
    }
  }
  return { tools, statuses };
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
