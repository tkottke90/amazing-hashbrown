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
    if (registry.list(true).find((w) => w.id === wikiId)?.status === 'readOnly') {
      return `Wiki "${wikiId}" is read-only and cannot be written to directly.`;
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
    // "Reads the file from disk itself" replaced "Accepts the current file
    // content as the new ground truth" after auto-eval round 2 (wiki-lint,
    // 2026-07-28): glm read that phrasing as "I must fetch the content and
    // pass it in", reasoned "I don't have the file content. I'll need to read
    // the file first", and called wiki_read_page instead of this tool. The
    // schema has no content param — the description now says so outright.
    description:
      'Re-establish the sha256 baseline for a raw source file whose content has drifted ' +
      'from its stored hash. Use to fix source_drift findings from wiki_lint. ' +
      'Reads the file from disk itself and records its current content as the new ground ' +
      'truth — no content argument exists and no prior wiki_read_page is needed. ' +
      'Does not restore the original.',
    schema: WikiRebaselineSourceSchema,
  },
);
