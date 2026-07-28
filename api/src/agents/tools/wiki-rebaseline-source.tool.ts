import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getWikiRegistry } from '../../services/wiki.js';

const WikiRebaselineSourceSchema = z.object({
  wikiId: z.string().describe('Wiki domain ID the raw file belongs to.'),
  rawFilePath: z
    .string()
    .describe(
      'The `page` value from a source_drift lint finding (e.g. raw/articles/some-source.md).',
    ),
});

export const wikiRebaselineSourceTool = tool(
  async ({ wikiId, rawFilePath }) => {
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
    try {
      const result = await wiki.rebaselineRawSource(rawFilePath);
      return `Rebaselined raw source at ${result.path}. The stored sha256 now matches the file's current content.`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return `Raw file not found: ${rawFilePath}`;
      }
      throw err;
    }
  },
  {
    name: 'wiki_rebaseline_source',
    description:
      'Re-establish the sha256 baseline for a raw source file whose content has drifted ' +
      'from its stored hash. Use to fix source_drift findings from wiki_lint. ' +
      'Accepts the current file content as the new ground truth — does not restore the original.',
    schema: WikiRebaselineSourceSchema,
  },
);
