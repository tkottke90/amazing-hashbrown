import { tool } from '@langchain/core/tools';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createAgent, createMiddleware } from 'langchain';
import type { RegisteredTool } from '@tkottke90/tools-manager';
import type { SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { getAgentInstructions } from '../config/agent-instructions.js';
import { logger, serializeError } from '../config/logger.js';
import { createProvider } from '../services/provider-factory.js';
import { toolsManager } from '../services/tools-manager.js';
import { askUserTool } from './tools/ask-user.tool.js';
import { uploadImageTool } from './tools/upload-image.tool.js';
import { wikiLocateTool } from './tools/wiki-locate.tool.js';
import { wikiOrientTool } from './tools/wiki-orient.tool.js';
import { wikiReadPageTool } from './tools/wiki-read-page.tool.js';
import { wikiSearchTool } from './tools/wiki-search.tool.js';
import { getAfterAgentContextSchema, runAfterAgentPipeline } from './after-agent.js';
import { buildSystemPrompt } from './system-prompt.js';

// Set once at startup (see api/src/index.ts) with the same shared db
// connection every other store uses. SqliteSaver accepts the connection
// directly — no separate file, no separate connection.
let _checkpointerDb: SqliteDatabase | null = null;
let _checkpointer: SqliteSaver | null = null;

export function initChatAgent(db: SqliteDatabase): void {
  _checkpointerDb = db;
}

// Exported so the threads route/handlers can call deleteThread()/list()/put()
// directly for delete and fork support — same singleton the agent itself uses.
export function getCheckpointer(): SqliteSaver {
  if (!_checkpointer) {
    if (!_checkpointerDb) {
      throw new Error('Chat agent not initialised — call initChatAgent() first');
    }
    _checkpointer = new SqliteSaver(_checkpointerDb);
  }
  return _checkpointer;
}

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
        logger.error('after-agent: pipeline failed to start', {
          threadId,
          err: serializeError(err),
        });
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

  const systemPrompt = buildSystemPrompt(getAgentInstructions());
  const agent = createAgent({
    model: llm,
    // Built-ins use their original LangChain tool objects to preserve interrupt() semantics.
    // MCP tools are converted from RegisteredTool.
    tools: [
      askUserTool,
      uploadImageTool,
      wikiSearchTool,
      wikiReadPageTool,
      wikiLocateTool,
      wikiOrientTool,
      ...mcpTools,
    ],
    systemPrompt,
    checkpointer: getCheckpointer(),
    middleware: [afterAgentMiddleware],
  });

  return { agent, systemPrompt };
}

export type ChatAgent = Awaited<ReturnType<typeof buildChatAgent>>['agent'];

// Caches both the agent and the exact system prompt string it was built
// with, so a caller reading systemPrompt always matches the cached agent
// instance — a getter that recomputed buildSystemPrompt() independently
// could drift from it if config/AGENT.md changes between cache builds.
const _agents = new Map<string, { agent: ChatAgent; systemPrompt: string }>();

export async function getChatAgent(
  provider?: string,
  model?: string,
): Promise<{ agent: ChatAgent; systemPrompt: string }> {
  const key = `${provider ?? ''}:${model ?? ''}`;
  if (!_agents.has(key)) {
    _agents.set(key, await buildChatAgent(provider, model));
  }
  return _agents.get(key)!;
}

export function invalidateChatAgent(): void {
  _agents.clear();
}
