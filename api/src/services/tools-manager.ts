import { ToolsManager } from '@tkottke90/tools-manager';
import type { RegisteredTool } from '@tkottke90/tools-manager';
import { askUserTool } from '../agents/tools/ask-user.tool.js';
import { uploadImageTool } from '../agents/tools/upload-image.tool.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export const toolsManager = new ToolsManager({ configDir: env.mcpConfigDir as string });

function wrapBuiltin(
  lcTool: { name: string; description: string; schema: unknown },
  invoke: (args: Record<string, unknown>) => Promise<unknown>,
): RegisteredTool {
  return {
    name: lcTool.name,
    description: lcTool.description,
    // Double-cast required: schema is a zod v4 ZodObject at runtime; RegisteredTool.parameters
    // is typed against the tools-manager's zod dependency — structurally identical but a
    // different module instance, just like the cast in mcp-client.ts.
    parameters: lcTool.schema as unknown as RegisteredTool['parameters'],
    source: 'builtin',
    execute: invoke,
  };
}

toolsManager.register(
  wrapBuiltin(askUserTool, (args) =>
    askUserTool.invoke(args as Parameters<typeof askUserTool.invoke>[0]),
  ),
);

toolsManager.register(
  wrapBuiltin(uploadImageTool, (args) =>
    uploadImageTool.invoke(args as Parameters<typeof uploadImageTool.invoke>[0]),
  ),
);

export async function bootToolsManager(): Promise<void> {
  await toolsManager.boot();
  logger.info('ToolsManager booted', { configDir: env.mcpConfigDir });

  const servers = toolsManager.listMcpServers();
  const serverCount = Object.keys(servers).length;
  if (serverCount > 0) {
    logger.info(`MCP servers configured: ${serverCount}`, { servers: Object.keys(servers) });
  }
}
