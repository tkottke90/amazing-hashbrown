import { tool } from '@langchain/core/tools';
import { ChatOllama } from '@langchain/ollama';
import { MemorySaver } from '@langchain/langgraph';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import type { RegisteredTool } from '@tkottke90/tools-manager';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { toolsManager } from '../services/tools-manager.js';
import { askUserTool } from './tools/ask-user.tool.js';
import { uploadImageTool } from './tools/upload-image.tool.js';

const checkpointer = new MemorySaver();

export function mcpToolToLangChain(t: RegisteredTool) {
  return tool(
    async (args: Record<string, unknown>) => {
      const result = await t.execute(args);
      return typeof result === 'string' ? result : JSON.stringify(result);
    },
    {
      name: t.name,
      description: t.description,
      schema: t.parameters,
    },
  );
}

async function buildChatAgent() {
  const llm = new ChatOllama({
    model: env.llmModel,
    baseUrl: env.llmBaseUrl,
  });

  // Trigger MCP initialization so mcpTools are populated
  await toolsManager.getTools().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('MCP initialization failed — MCP tools will be unavailable', { err: message });
  });

  const mcpTools = toolsManager
    .list()
    .filter((t) => t.source === 'mcp')
    .map(mcpToolToLangChain);

  if (mcpTools.length > 0) {
    logger.info(`Loaded ${mcpTools.length} MCP tool(s)`, {
      tools: mcpTools.map((t) => t.name),
    });
  }

  return createReactAgent({
    llm,
    // Built-ins use their original LangChain tool objects to preserve interrupt() semantics.
    // MCP tools are converted from RegisteredTool.
    tools: [askUserTool, uploadImageTool, ...mcpTools],
    checkpointSaver: checkpointer,
  });
}

export type ChatAgent = Awaited<ReturnType<typeof buildChatAgent>>;

let _agent: ChatAgent | undefined;

export async function getChatAgent(): Promise<ChatAgent> {
  _agent ??= await buildChatAgent();
  return _agent;
}

export function invalidateChatAgent(): void {
  _agent = undefined;
}
