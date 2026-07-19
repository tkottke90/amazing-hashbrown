import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { logger, serializeError } from '../../config/logger.js';
import { getWikiRegistry } from '../../services/wiki.js';

const WikiSearchSchema = z.object({
  query: z.string().describe('Natural language search query'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(5)
    .describe('Maximum results to return (default 5)'),
});

export const wikiSearchTool = tool(
  async ({ query, limit }) => {
    let registry;
    try {
      registry = await getWikiRegistry();
    } catch {
      return 'Wiki knowledge base is not available.';
    }

    const wikis = registry.list();
    if (wikis.length === 0) return 'No wiki domains are configured.';

    const allResults: Array<{ wikiId: string; path: string; title: string; score: number }> = [];

    for (const entry of wikis) {
      try {
        const wiki = await registry.load(entry.id);
        // No explicit mode — semanticSearch already defaults to 'hybrid' when
        // an embeddingProvider is configured and falls back to 'keyword'
        // otherwise, so this degrades gracefully with embeddings disabled.
        const results = await wiki.semanticSearch(query, { limit });
        allResults.push(
          ...results.map((r: { path: string; score: number; title: string }) => ({
            wikiId: entry.id,
            ...r,
          })),
        );
      } catch (err) {
        logger.warn('wiki_search: error searching wiki', {
          wikiId: entry.id,
          err: serializeError(err),
        });
      }
    }

    if (allResults.length === 0) return 'No results found for the given query.';

    allResults.sort((a, b) => b.score - a.score);
    return JSON.stringify(allResults.slice(0, limit), null, 2);
  },
  {
    name: 'wiki_search',
    description:
      'Search the knowledge base for pages relevant to a query. Returns ranked results with wikiId and path. Use wiki_read_page to fetch the full content of a specific page.',
    schema: WikiSearchSchema,
  },
);
