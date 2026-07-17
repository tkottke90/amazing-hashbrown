import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { createAgent, createMiddleware } from 'langchain';
import type { RegisteredTool } from '@tkottke90/tools-manager';
import { logger } from '../config/logger.js';
import { createProvider } from '../services/provider-factory.js';
import { toolsManager } from '../services/tools-manager.js';
import { askUserTool } from './tools/ask-user.tool.js';
import { uploadImageTool } from './tools/upload-image.tool.js';
import { wikiReadPageTool } from './tools/wiki-read-page.tool.js';
import { wikiSearchTool } from './tools/wiki-search.tool.js';
import { getAfterAgentContextSchema, runAfterAgentPipeline } from './after-agent.js';

const checkpointer = new MemorySaver();

// Fires once per completed turn (does not fire on a turn that pauses via
// interrupt() — only once the turn, including a resumed HITL turn, actually
// completes). The pipeline itself is fire-and-forget: this hook must not
// await it, or the framework would hold the turn's response open until the
// background wiki-write pipeline finishes.
const afterAgentMiddleware = createMiddleware({
  name: 'AfterAgentMiddleware',
  contextSchema: getAfterAgentContextSchema(),
  afterAgent: (state, runtime) => {
    const threadId = runtime.configurable?.thread_id;
    if (threadId) {
      void runAfterAgentPipeline({
        threadId,
        messages: state.messages,
        provider: runtime.context?.provider,
        model: runtime.context?.model,
        requestAfterAgentEnabled: runtime.context?.afterAgentEnabled,
      }).catch((err: unknown) => {
        logger.error('after-agent: pipeline failed to start', { threadId, err });
      });
    }
    return undefined;
  },
});

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

async function buildChatAgent(provider?: string, model?: string) {
  const llm = createProvider(provider, model);

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

  return createAgent({
    model: llm,
    // Built-ins use their original LangChain tool objects to preserve interrupt() semantics.
    // MCP tools are converted from RegisteredTool.
    tools: [askUserTool, uploadImageTool, wikiSearchTool, wikiReadPageTool, ...mcpTools],
    checkpointer,
    middleware: [afterAgentMiddleware],
  });
}

export type ChatAgent = Awaited<ReturnType<typeof buildChatAgent>>;

const _agents = new Map<string, ChatAgent>();

export async function getChatAgent(provider?: string, model?: string): Promise<ChatAgent> {
  const key = `${provider ?? ''}:${model ?? ''}`;
  if (!_agents.has(key)) {
    _agents.set(key, await buildChatAgent(provider, model));
  }
  return _agents.get(key)!;
}

export function invalidateChatAgent(): void {
  _agents.clear();
}
