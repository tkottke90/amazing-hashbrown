import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { logger, serializeError } from '../../config/logger.js';
import { env } from '../../config/env.js';
import { getWikiRegistry } from '../../services/wiki.js';

const WikiReadPageSchema = z.object({
  wikiId: z.string().describe('Wiki domain ID returned by wiki_search (e.g. "user")'),
  path: z
    .string()
    .describe(
      'Page path relative to the wiki root returned by wiki_search (e.g. "entities/foo.md")',
    ),
  truncate: z
    .boolean()
    .default(true)
    .describe(
      'When true (default), large pages are truncated with guidance to use rlm_query. ' +
        'Set to false to retrieve the full text — pass the result as the corpus to rlm_query.',
    ),
});

export const wikiReadPageTool = tool(
  async ({ wikiId, path, truncate }) => {
    let registry;
    try {
      registry = await getWikiRegistry();
    } catch {
      return 'Wiki knowledge base is not available.';
    }

    let wiki;
    try {
      wiki = await registry.load(wikiId);
    } catch {
      return `Wiki "${wikiId}" is not registered. Use wiki_search to find available pages.`;
    }

    try {
      const page = await wiki.readPage(path);
      const tags = page.frontmatter.tags.join(', ');
      const full = `# ${page.title}\n\nType: ${page.frontmatter.type}\nTags: ${tags}\n\n${page.content}`;

      const threshold = env.rlm.truncateThreshold;
      if (truncate && full.length > threshold) {
        const truncated = full.slice(0, threshold);
        return (
          truncated +
          `\n\n[TRUNCATED: showing ${threshold.toLocaleString()} of ${full.length.toLocaleString()} characters]\n` +
          `This page exceeds the read limit. To search for specific information:\n` +
          `1. Re-call wiki_read_page with truncate: false to get the complete text.\n` +
          `2. Pass that text as the corpus argument to rlm_query with your specific question.`
        );
      }

      return full;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return `Page "${path}" not found in wiki "${wikiId}". Use wiki_search to find available pages.`;
      }
      logger.warn('wiki_read_page: error reading page', { wikiId, path, err: serializeError(err) });
      return `Error reading page "${path}": ${(err as Error).message}`;
    }
  },
  {
    name: 'wiki_read_page',
    description:
      'Read the full content of a wiki page. Use wiki_search first to find relevant page paths and their wikiId.',
    schema: WikiReadPageSchema,
  },
);
