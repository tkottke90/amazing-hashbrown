import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createAgent } from 'langchain';
import type { SqliteDatabase } from '@tkottke90/llm-common-types/db';
import { logger } from '../config/logger.js';
import { createProvider } from '../services/provider-factory.js';
import { askUserTool } from './tools/ask-user.tool.js';
import { wikiLintTool } from './tools/wiki-lint.tool.js';
import { wikiLocateTool } from './tools/wiki-locate.tool.js';
import { wikiOrientTool } from './tools/wiki-orient.tool.js';
import { wikiReadPageTool } from './tools/wiki-read-page.tool.js';
import { wikiCreateDomainTool } from './tools/wiki-create-domain.tool.js';
import { wikiRegisterDomainTool } from './tools/wiki-register-domain.tool.js';
import { wikiSearchTool } from './tools/wiki-search.tool.js';
import { webFetchTool } from './tools/web-fetch.tool.js';
import { makeGetToolKeyTool } from './tools/get-tool-key.tool.js';
import {
  buildWikiWriteTools,
  createContextWindowMiddleware,
  getCheckpointer,
} from './chat-agent.js';
import { ambientContextMiddleware } from './ambient-context.middleware.js';
import { wikiOrientationContextMiddleware } from './wiki-orientation-context.middleware.js';
import { buildWikiIngestionSystemPrompt } from './wiki-ingestion-system-prompt.js';
import { contentBlockSanitizerMiddleware } from './content-block-sanitizer.middleware.js';
import { createRecursionGuardMiddleware } from './recursion-guard.middleware.js';
import { attachmentAwarenessMiddleware } from './attachment-awareness.middleware.js';
import { wikiReferenceExpansionMiddleware } from './wiki-reference-expansion.middleware.js';
import { binaryContentFetchMiddleware } from './binary-content-fetch.middleware.js';
import { modelInputSnapshotMiddleware } from './model-input-snapshot.middleware.js';
import { env } from '../config/env.js';

export type WikiIngestionAgent = Awaited<ReturnType<typeof buildWikiIngestionAgent>>['agent'];

let _db: SqliteDatabase | null = null;

export function initWikiAgent(db: SqliteDatabase): void {
  _db = db;
}

// Exported so the wiki ingestion chat's actual bound tool list is directly
// unit-testable (e.g. "includes wiki_rebaseline_source") without building a
// real createAgent()/provider — same rationale and shape as chat-agent.ts's
// buildWikiWriteTools(), which this now composes rather than re-listing the
// three overlapping tools by hand (that hand-duplication is exactly how
// wiki_rebaseline_source went missing here for three weeks after it was
// added to buildWikiWriteTools() — see docs/superpowers/specs/
// 2026-11-20-wiki-ingestion-rebaseline-tool-gap-design.md).
export function buildWikiIngestionTools() {
  return [
    askUserTool,
    wikiLocateTool,
    wikiOrientTool,
    wikiSearchTool,
    wikiReadPageTool,
    ...buildWikiWriteTools(),
    wikiLintTool,
    wikiCreateDomainTool,
    wikiRegisterDomainTool,
    webFetchTool,
    makeGetToolKeyTool(),
  ];
}

// Exported for the same reason as buildWikiIngestionTools() above — lets a
// test assert modelInputSnapshotMiddleware is actually wired in without a
// real agent build.
export function buildWikiIngestionMiddleware() {
  return [
    contentBlockSanitizerMiddleware,
    createRecursionGuardMiddleware({
      recursionLimit: env.agent?.recursionLimit ?? 100,
      warnThreshold: env.agent?.recursionWarnThreshold ?? 0.75,
      loopGuard: env.agent?.loopGuard,
      escalationMode: 'interrupt',
    }),
    attachmentAwarenessMiddleware,
    wikiReferenceExpansionMiddleware,
    binaryContentFetchMiddleware,
    createContextWindowMiddleware(env.chat?.contextWindow),
    ambientContextMiddleware,
    wikiOrientationContextMiddleware,
    // Innermost wrapModelCall — must stay last, same placement rule
    // chat-agent.ts's three call sites already follow (see
    // model-input-snapshot.middleware.ts's own header comment).
    modelInputSnapshotMiddleware,
  ];
}

async function buildWikiIngestionAgent(provider?: string, model?: string) {
  if (!_db) {
    throw new Error('Wiki ingestion agent not initialised — call initWikiAgent() first');
  }

  const llm = createProvider(provider, model);
  const systemPrompt = buildWikiIngestionSystemPrompt();

  const agent = createAgent({
    model: llm,
    tools: buildWikiIngestionTools(),
    systemPrompt,
    checkpointer: getCheckpointer(),
    middleware: buildWikiIngestionMiddleware(),
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
