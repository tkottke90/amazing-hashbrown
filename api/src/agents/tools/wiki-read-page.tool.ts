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
      'When true (default), large pages are truncated at the read threshold. ' +
        'Set to false to retrieve the full text.',
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
          `This wiki page is too long to display fully. The entry should be split into focused sub-pages.\n` +
          `Answer from the visible portion above. If the information is not visible here, let the user\n` +
          `know this wiki page needs to be restructured.`
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
