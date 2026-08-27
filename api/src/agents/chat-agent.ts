import { tool } from '@langchain/core/tools';
import { trimMessages } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createAgent, createMiddleware } from 'langchain';
import type { RegisteredTool } from '@tkottke90/tools-manager';
import type { SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { getAgentInstructions } from '../config/agent-instructions.js';
import { env } from '../config/env.js';
import { logger, serializeError } from '../config/logger.js';
import { createProvider } from '../services/provider-factory.js';
import { toolsManager } from '../services/tools-manager.js';
import { askUserTool } from './tools/ask-user.tool.js';
import { shellExecTool } from './tools/shell-exec.tool.js';
import { uploadImageTool } from './tools/upload-image.tool.js';
import { makeWikiAddCrossLinkTool } from './tools/wiki-add-cross-link.tool.js';
import { makeWikiCreatePageTool } from './tools/wiki-create-page.tool.js';
import { wikiLintTool } from './tools/wiki-lint.tool.js';
import { wikiLocateTool } from './tools/wiki-locate.tool.js';
import { wikiOrientTool } from './tools/wiki-orient.tool.js';
import { wikiReadPageTool } from './tools/wiki-read-page.tool.js';
import { makeWikiRebaselineSourceTool } from './tools/wiki-rebaseline-source.tool.js';
import { wikiRegisterDomainTool } from './tools/wiki-register-domain.tool.js';
import { wikiSearchTool } from './tools/wiki-search.tool.js';
import { makeWikiUpdatePageTool } from './tools/wiki-update-page.tool.js';
import { rlmQueryTool } from './tools/rlm-query.tool.js';
import { searchSkillsTool } from './tools/search-skills.tool.js';
import { searchConversationTool } from './tools/search-conversation.tool.js';
import { webFetchTool } from './tools/web-fetch.tool.js';
import { getAfterAgentContextSchema, runAfterAgentPipeline } from './after-agent.js';
import { buildSystemPrompt } from './system-prompt.js';
import { createRecursionGuardMiddleware } from './recursion-guard.middleware.js';
import { createSkillExpansionMiddleware } from './skill-expansion.middleware.js';
import { createSkillGatedToolsMiddleware } from './skill-gated-tools.middleware.js';
import { GATED_SKILL_REGISTRATIONS } from './gated-skill-registrations.js';
import { makeCreateWorkspaceTool } from './tools/create-workspace.tool.js';
import { makeCreateProjectTool } from './tools/create-project.tool.js';

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

// Rough token estimator: 4 characters ≈ 1 token. Used by the context window
// middleware to avoid a model round-trip for counting. Accurate enough for the
// purpose of keeping context below a configurable ceiling.
function estimateTokens(messages: BaseMessage[]): number {
  return messages.reduce((sum, m) => {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return sum + Math.ceil(text.length / 4);
  }, 0);
}

// Trims old messages from the LangGraph state before each agent turn so the
// model never receives more tokens than the configured ceiling. Uses
// trimMessages from @langchain/core with strategy:'last' (keep most-recent)
// and startOn:'human' (never start mid-tool-call-result pair) to preserve
// tool-call/tool-result pairing required by LangGraph.
export const contextWindowMiddleware = createMiddleware({
  name: 'ContextWindowMiddleware',
  beforeAgent: async (state) => {
    const cfg = env.chat?.contextWindow;
    // Enabled by default; only skip if explicitly set to false.
    if (cfg?.enabled === false) return undefined;

    const trimmer = trimMessages({
      maxTokens: cfg?.maxTokens ?? 32000,
      strategy: 'last',
      tokenCounter: estimateTokens,
      includeSystem: true,
      allowPartial: false,
      startOn: 'human',
    });

    const trimmed = await trimmer.invoke(state.messages as BaseMessage[]);
    if (trimmed.length === state.messages.length) return undefined;

    logger.debug('contextWindow: trimmed message history', {
      before: state.messages.length,
      after: trimmed.length,
      maxTokens: cfg?.maxTokens ?? 32000,
    });

    return { messages: trimmed };
  },
});

const skillExpansionMiddleware = createSkillExpansionMiddleware(GATED_SKILL_REGISTRATIONS);
const skillGatedToolsMiddleware = createSkillGatedToolsMiddleware(GATED_SKILL_REGISTRATIONS);

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

// Built-ins use their original LangChain tool objects to preserve interrupt()
// semantics. Shared by buildChatAgent and buildWorkspaceChatAgent so both
// agent flavors see the exact same tool set — MCP tools are appended
// separately by loadMcpTools() since they're fetched, not static.
const STATIC_CHAT_TOOLS = [
  askUserTool,
  shellExecTool,
  uploadImageTool,
  wikiSearchTool,
  wikiReadPageTool,
  wikiLocateTool,
  wikiOrientTool,
  wikiLintTool,
  wikiRegisterDomainTool,
  webFetchTool,
  rlmQueryTool,
  searchSkillsTool,
  searchConversationTool,
];

// Skill-gated tools — see GATED_SKILL_REGISTRATIONS below. Graph-registered
// like STATIC_CHAT_TOOLS (so ToolNode can execute them), but hidden from the
// model until their matching skill is invoked; gating only affects what
// skillGatedToolsMiddleware exposes to the model per-call. Built fresh per
// agent construction (not a module-scope constant) — same reason as
// buildWikiWriteTools() below: create-workspace.tool.ts's own import chain
// leads back to this file (via workspaces.handlers.ts), so calling the
// factories at module load time would hit a circular-import TDZ error.
function buildGatedTools() {
  return [makeCreateWorkspaceTool(), makeCreateProjectTool()];
}

// The four write-capable wiki tools are built fresh per agent construction
// (not shared singletons like STATIC_CHAT_TOOLS) so each can close over its
// own allowedWikiId restriction — see wiki-write-guard.ts and issue #79.
export function buildWikiWriteTools(allowedWikiId?: string) {
  return [
    makeWikiCreatePageTool(allowedWikiId),
    makeWikiUpdatePageTool(allowedWikiId),
    makeWikiAddCrossLinkTool(allowedWikiId),
    makeWikiRebaselineSourceTool(allowedWikiId),
  ];
}

async function loadMcpTools() {
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

  return mcpTools;
}

async function buildChatAgent(provider?: string, model?: string) {
  const llm = createProvider(provider, model);
  const mcpTools = await loadMcpTools();

  const systemPrompt = buildSystemPrompt(getAgentInstructions());
  const agent = createAgent({
    model: llm,
    tools: [...STATIC_CHAT_TOOLS, ...buildGatedTools(), ...buildWikiWriteTools(), ...mcpTools],
    systemPrompt,
    checkpointer: getCheckpointer(),
    middleware: [
      createRecursionGuardMiddleware(
        env.agent?.recursionLimit ?? 100,
        env.agent?.recursionWarnThreshold ?? 0.75,
      ),
      skillExpansionMiddleware,
      skillGatedToolsMiddleware,
      contextWindowMiddleware,
      afterAgentMiddleware,
    ],
  });

  return { agent, systemPrompt };
}

export type ChatAgent = Awaited<ReturnType<typeof buildChatAgent>>['agent'];

// ---------------------------------------------------------------------------
// Workspace chat agent — same tool set and middleware as buildChatAgent, but
// with a per-workspace system prompt (name/goal/location/wiki orientation).
// ---------------------------------------------------------------------------

export interface WorkspaceChatContext {
  name: string;
  goal: string | null;
  location: string;
  systemPrompt: string | null;
  // Resolved wiki domain name (not the raw id) for the workspace's bound
  // wiki, or null when the workspace has none configured.
  wikiDomain: string | null;
}

function buildWorkspaceContextBlock(ctx: WorkspaceChatContext): string {
  const lines = [
    `You are working within the workspace "${ctx.name}".`,
    `Location on disk: ${ctx.location}`,
  ];
  if (ctx.goal) lines.push(`Goal: ${ctx.goal}`);
  if (ctx.wikiDomain) {
    lines.push(
      `Bound wiki domain: "${ctx.wikiDomain}" — this workspace's memory lives here; orient to this domain for wiki lookups and writes relevant to this workspace.`,
    );
  }
  if (ctx.systemPrompt?.trim()) {
    lines.push('', ctx.systemPrompt.trim());
  }
  return lines.join('\n');
}

async function buildWorkspaceChatAgent(
  workspaceContext: WorkspaceChatContext,
  provider?: string,
  model?: string,
  allowedWikiId?: string,
) {
  const llm = createProvider(provider, model);
  const mcpTools = await loadMcpTools();

  const systemPrompt = buildSystemPrompt(
    getAgentInstructions(),
    buildWorkspaceContextBlock(workspaceContext),
  );
  const agent = createAgent({
    model: llm,
    tools: [
      ...STATIC_CHAT_TOOLS,
      ...buildGatedTools(),
      ...buildWikiWriteTools(allowedWikiId),
      ...mcpTools,
    ],
    systemPrompt,
    checkpointer: getCheckpointer(),
    middleware: [
      createRecursionGuardMiddleware(
        env.agent?.recursionLimit ?? 100,
        env.agent?.recursionWarnThreshold ?? 0.75,
      ),
      skillExpansionMiddleware,
      skillGatedToolsMiddleware,
      contextWindowMiddleware,
      afterAgentMiddleware,
    ],
  });

  return { agent, systemPrompt };
}

// Keyed by workspaceId (not just provider:model, unlike _agents below) —
// each workspace's system prompt differs (name/goal/wiki), so the cache key
// must include it or one workspace's prompt would silently leak onto
// another's session whenever they share a provider/model pair.
const _workspaceAgents = new Map<string, { agent: ChatAgent; systemPrompt: string }>();

export async function getWorkspaceChatAgent(
  workspaceId: string,
  workspaceContext: WorkspaceChatContext,
  provider?: string,
  model?: string,
  allowedWikiId?: string,
): Promise<{ agent: ChatAgent; systemPrompt: string }> {
  const key = `${workspaceId}:${provider ?? ''}:${model ?? ''}`;
  if (!_workspaceAgents.has(key)) {
    _workspaceAgents.set(
      key,
      await buildWorkspaceChatAgent(workspaceContext, provider, model, allowedWikiId),
    );
  }
  return _workspaceAgents.get(key)!;
}

// Call whenever a workspace's goal/systemPrompt/wikiId changes, or a new
// summary is generated — anything that changes what belongs in its system
// prompt. Clears only this workspace's cached agents, not every workspace's.
export function invalidateWorkspaceChatAgent(workspaceId: string): void {
  for (const key of _workspaceAgents.keys()) {
    if (key.startsWith(`${workspaceId}:`)) _workspaceAgents.delete(key);
  }
}

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
