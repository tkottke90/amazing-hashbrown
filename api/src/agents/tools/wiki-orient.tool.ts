import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getWikiRegistry } from '../../services/wiki.js';
import { getActiveSseWriter } from '../active-sse-writer.js';
import { formatWikiOrientation } from '../wiki-orientation-format.js';

const WikiOrientSchema = z.object({
  wikiId: z
    .string()
    .describe(
      'Wiki domain ID to orient on (e.g. "user"), as returned by wiki_locate or wiki_search.',
    ),
});

export const wikiOrientTool = tool(
  async ({ wikiId }, config) => {
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
      return `Wiki "${wikiId}" is not registered. Use wiki_locate to find available domains.`;
    }

    const orientResult = await wiki.orient();

    const threadId = config?.configurable?.thread_id as string | undefined;
    getActiveSseWriter(threadId ?? '')?.({ type: 'wiki_oriented', wikiId, wikiName: wikiId });

    return formatWikiOrientation(wikiId, orientResult);
  },
  {
    name: 'wiki_orient',
    description:
      "Load a wiki domain's full structural state — tag taxonomy, page index, recent activity — before " +
      'searching or writing in it. Call this once you already have a wikiId (from wiki_locate or a wiki_search ' +
      'result) and want the lay of the land before deciding what to search for or write.',
    schema: WikiOrientSchema,
  },
);
