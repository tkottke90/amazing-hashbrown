import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createAgent } from 'langchain';
import type { SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { logger } from '../config/logger.js';
import { createProvider } from '../services/provider-factory.js';
import { askUserTool } from './tools/ask-user.tool.js';
import { wikiAddCrossLinkTool } from './tools/wiki-add-cross-link.tool.js';
import { wikiCreatePageTool } from './tools/wiki-create-page.tool.js';
import { wikiLintTool } from './tools/wiki-lint.tool.js';
import { wikiLocateTool } from './tools/wiki-locate.tool.js';
import { wikiOrientTool } from './tools/wiki-orient.tool.js';
import { wikiReadPageTool } from './tools/wiki-read-page.tool.js';
import { wikiRegisterDomainTool } from './tools/wiki-register-domain.tool.js';
import { wikiSearchTool } from './tools/wiki-search.tool.js';
import { wikiUpdatePageTool } from './tools/wiki-update-page.tool.js';
import { getCheckpointer } from './chat-agent.js';
import { buildWikiIngestionSystemPrompt } from './wiki-ingestion-system-prompt.js';

export type WikiIngestionAgent = Awaited<ReturnType<typeof buildWikiIngestionAgent>>['agent'];

let _db: SqliteDatabase | null = null;

export function initWikiAgent(db: SqliteDatabase): void {
  _db = db;
}

async function buildWikiIngestionAgent(provider?: string, model?: string) {
  if (!_db) {
    throw new Error('Wiki ingestion agent not initialised — call initWikiAgent() first');
  }

  const llm = createProvider(provider, model);
  const systemPrompt = buildWikiIngestionSystemPrompt();

  const agent = createAgent({
    model: llm,
    tools: [
      askUserTool,
      wikiLocateTool,
      wikiOrientTool,
      wikiSearchTool,
      wikiReadPageTool,
      wikiCreatePageTool,
      wikiUpdatePageTool,
      wikiAddCrossLinkTool,
      wikiLintTool,
      wikiRegisterDomainTool,
    ],
    systemPrompt,
    checkpointer: getCheckpointer(),
  });

  return { agent, systemPrompt };
}

const _agents = new Map<string, { agent: WikiIngestionAgent; systemPrompt: string }>();

export async function getWikiIngestionAgent(
  provider?: string,
  model?: string,
): Promise<{ agent: WikiIngestionAgent; systemPrompt: string }> {
  const key = `wiki:${provider ?? ''}:${model ?? ''}`;
  if (!_agents.has(key)) {
    _agents.set(key, await buildWikiIngestionAgent(provider, model));
  }
  return _agents.get(key)!;
}

export function invalidateWikiIngestionAgent(): void {
  _agents.clear();
  logger.info('Wiki ingestion agent cache cleared');
}

// Exported so SqliteSaver is accessible — wiki threads share the same
// SQLite db and checkpointer as the chat agent (different thread_id namespace).
export { getCheckpointer };
