import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getWikiRegistry } from '../../services/wiki.js';

const WikiAddCrossLinkSchema = z.object({
  wikiId: z.string().describe('Wiki domain ID the pages belong to.'),
  fromPage: z
    .string()
    .describe('Path of the page to add the link from, relative to the wiki root.'),
  toPage: z.string().describe('Path or slug of the page to link to.'),
});

export const wikiAddCrossLinkTool = tool(
  async ({ wikiId, fromPage, toPage }) => {
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
    const result = await wiki.addCrossLink({ fromPage, toPage });
    const warnings = result.warnings.map((w) => w.message).join(' ');
    if (warnings.includes('already present')) {
      return `Cross-link from ${fromPage} to ${toPage} already exists.`;
    }
    return `Added cross-link from ${fromPage} to ${toPage}.${warnings ? ` ${warnings}` : ''}`;
  },
  {
    name: 'wiki_add_cross_link',
    // Direction guidance rewritten after auto-eval round 3 (wiki-lint,
    // 2026-07-28): the old text ("call wiki_read_page on the orphaned page
    // first to identify a suitable link target") implied linking FROM the
    // orphan outward, but checkOrphans counts inbound wikilinks only — an
    // outbound link leaves the page just as orphaned on the next lint run.
    // Ornith reasoned its way to the correct direction despite the old
    // wording; the description now states it outright.
    description:
      'Add a cross-link from one wiki page to another under a "## Related Pages" section ' +
      '(creating the section if absent). Use to fix orphans findings from wiki_lint. ' +
      'An orphan has no inbound links, so the orphaned page must be the link target: pass a ' +
      'related page as fromPage and the orphaned page as toPage — a link from the orphan ' +
      'outward does not fix the finding. Read the orphaned page to learn which pages it ' +
      'relates to, then link from one of those.',
    schema: WikiAddCrossLinkSchema,
  },
);
