import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { logger } from '../../config/logger.js';
import { getWikiRegistry } from '../../services/wiki.js';

const WikiReadPageSchema = z.object({
  wikiId: z
    .string()
    .describe('Wiki domain ID returned by wiki_search (e.g. "user")'),
  path: z
    .string()
    .describe(
      'Page path relative to the wiki root returned by wiki_search (e.g. "entities/foo.md")',
    ),
});

export const wikiReadPageTool = tool(
  async ({ wikiId, path }) => {
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
      return `# ${page.title}\n\nType: ${page.frontmatter.type}\nTags: ${tags}\n\n${page.content}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return `Page "${path}" not found in wiki "${wikiId}". Use wiki_search to find available pages.`;
      }
      logger.warn('wiki_read_page: error reading page', { wikiId, path, err });
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
