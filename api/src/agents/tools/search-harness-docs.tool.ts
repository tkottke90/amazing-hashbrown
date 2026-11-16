// Reference/terminology lookup over this app's own harness documentation —
// GLOSSARY.md + legacy docs/App-Docs — built at release time into a
// standalone LlmWiki instance that is never registered with WikiRegistry
// (api/src/scripts/build-harness-docs-index.ts), so wiki_search/wiki_locate/
// AfterAgent never see or write to it. See
// docs/superpowers/specs/2026-11-13-harness-docs-tool-corpus-design.md.
//
// Does not answer "when should I use tool X" questions — that stays owned
// by each tool's own system-prompt section (SEARCH_HARNESS_DOCS_SECTION in
// system-prompt.ts says so explicitly).

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import path from 'node:path';
import { LlmWiki } from '@tkottke90/llm-wiki';
import { OllamaEmbeddingProvider } from '@tkottke90/llm-wiki/providers';
import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';

const WIKI_PATH = path.resolve(import.meta.dirname, '../../../generated/harness-docs-wiki');

// Leaves headroom under STUB_THRESHOLD_CHARS (tool-stub.ts, 10_000) so a
// combined multi-page response never trips the get_tool_key offload path —
// the whole point of this tool is a single-call answer, no second fetch.
const RESPONSE_BUDGET_CHARS = 8_000;
const SEARCH_LIMIT = 5;

const SearchHarnessDocsSchema = z.object({
  query: z
    .string()
    .describe(
      'A question or keyword about how this app itself works — terminology or configuration ' +
        '(e.g. "what is a Widget", "wiki domain", "MCP server configuration"). Not for questions ' +
        'about when to use a specific tool.',
    ),
});

let wikiPromise: Promise<LlmWiki> | undefined;

/** Lazily loads the singleton standalone LlmWiki instance for this process.
 * Same embeddingProvider construction as the real wiki registry
 * (api/src/services/wiki.ts getWikiRegistry()) so this corpus degrades to
 * keyword-only search exactly when the real wiki would, and uses the same
 * embedding model when one is configured. */
function getDefaultHarnessDocsWiki(): Promise<LlmWiki> {
  wikiPromise ??= LlmWiki.load(WIKI_PATH, {
    logger,
    embeddingProvider: env.embeddings.enabled
      ? new OllamaEmbeddingProvider({
          baseUrl: env.embeddings.baseUrl,
          model: env.embeddings.model,
        })
      : undefined,
  });
  return wikiPromise;
}

/** Builds the tool against an injected wiki loader so tests can supply a
 * real, temp-directory-backed LlmWiki instance (this repo's established
 * convention for testing wiki-backed tools — see
 * wiki-create-page.tool.test.ts) instead of stubbing the library. */
export function makeSearchHarnessDocsTool(getWiki: () => Promise<LlmWiki>) {
  return tool(
    async ({ query }) => {
      try {
        const wiki = await getWiki();
        const results = await wiki.semanticSearch(query, { limit: SEARCH_LIMIT });

        if (results.length === 0) {
          return `No harness documentation found matching "${query}".`;
        }

        const parts: string[] = [];
        let total = 0;
        for (const result of results) {
          const page = await wiki.readPage(result.path);
          const entry = `## ${page.title}\n${page.content.trim()}`;
          const next = total + entry.length + 2;
          if (next > RESPONSE_BUDGET_CHARS && parts.length > 0) break;
          parts.push(entry);
          total = next;
        }

        return parts.join('\n\n');
      } catch (err) {
        logger.error('search_harness_docs failed', { err });
        return `search_harness_docs failed: ${(err as Error).message}`;
      }
    },
    {
      name: 'search_harness_docs',
      description: 'Look up a reference/terminology question about how this app itself works.',
      schema: SearchHarnessDocsSchema,
    },
  );
}

export const searchHarnessDocsTool = makeSearchHarnessDocsTool(getDefaultHarnessDocsWiki);
