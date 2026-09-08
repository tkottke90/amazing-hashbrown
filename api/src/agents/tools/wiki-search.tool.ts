import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { logger, serializeError } from '../../config/logger.js';
import { getWikiRegistry } from '../../services/wiki.js';

const WikiSearchSchema = z.object({
  query: z.string().describe('Natural language search query'),
  wikiId: z
    .string()
    .optional()
    .describe(
      'Wiki domain ID to scope the search to (e.g. "user"), as returned by wiki_locate. ' +
        'Omit to search across every registered domain at once.',
    ),
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
  async ({ query, wikiId, limit }) => {
    let registry;
    try {
      registry = await getWikiRegistry();
    } catch {
      return 'Wiki knowledge base is not available.';
    }

    const wikis = registry.list();
    if (wikis.length === 0) return 'No wiki domains are configured.';

    let targets = wikis;
    if (wikiId) {
      targets = wikis.filter((entry) => entry.id === wikiId);
      if (targets.length === 0) {
        return `Wiki "${wikiId}" is not registered. Use wiki_locate to find available domains.`;
      }
    }

    const allResults: Array<{ wikiId: string; path: string; title: string; score: number }> = [];

    for (const entry of targets) {
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
      'Search page content for a query, either across every registered wiki domain (default) or scoped to a ' +
      'single domain by passing wikiId. Returns ranked results with wikiId and path. Pass wikiId once a domain is ' +
      'known — from wiki_locate, an earlier turn, or context already established — to search within just that ' +
      'domain; omit it to search across every domain at once. Use wiki_locate first if you want to know which ' +
      "domain covers a topic before any matching pages exist, or wiki_orient for a domain's full catalog rather " +
      'than a ranked subset. Use wiki_read_page to fetch the full content of a specific result.',
    schema: WikiSearchSchema,
  },
);
