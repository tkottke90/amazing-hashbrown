import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { updateWikiPage } from '../../services/wiki-write.js';

const WikiUpdatePageSchema = z.object({
  wikiId: z.string().describe('Wiki domain ID the page belongs to.'),
  path: z
    .string()
    .describe('Existing page path relative to the wiki root, from wiki_search or wiki_read_page.'),
  content: z.string().describe('Full replacement page body as markdown (no frontmatter).'),
  summary: z
    .string()
    .optional()
    .describe(
      'One-line summary for the wiki index entry, and the closest thing to a commit message this tool supports.',
    ),
  dryRun: z
    .boolean()
    .optional()
    .describe('If true, return a diff of what would change without writing anything.'),
});

// Minimal positional line-by-line diff for the dryRun preview — no new
// dependency. Not an LCS-based diff (no realignment around inserted/deleted
// lines), just a same-index comparison; a compact preview, not a patch.
function lineDiff(before: string, after: string): string {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const max = Math.max(beforeLines.length, afterLines.length);
  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    const a = beforeLines[i];
    const b = afterLines[i];
    if (a === b) continue;
    if (a !== undefined) out.push(`- ${a}`);
    if (b !== undefined) out.push(`+ ${b}`);
  }
  return out.length ? out.join('\n') : '(no changes)';
}

export const wikiUpdatePageTool = tool(
  async ({ wikiId, path, content, summary, dryRun }) => {
    const result = await updateWikiPage({ wikiId, path, content, summary, dryRun });

    switch (result.status) {
      case 'written': {
        const warnings = result.result.warnings.map((w) => w.message).join(' ');
        return `Updated page at ${result.result.path}.${warnings ? ` ${warnings}` : ''}`;
      }
      case 'dry_run':
        return `[dry run] Would update ${result.path}:\n${lineDiff(result.existingBody, result.proposedBody)}`;
      case 'not_found':
        return `Page not found at ${path}. Use wiki_create_page for a new page.`;
      case 'invalid_path':
        return 'Invalid path.';
      case 'wiki_unavailable':
        return 'Wiki knowledge base is not available.';
      case 'unknown_wiki':
        return `Wiki "${result.wikiId}" is not registered. Use wiki_locate to find available domains.`;
    }
  },
  {
    name: 'wiki_update_page',
    description:
      "Update an existing wiki page's content. Requires the page's existing path (from " +
      'wiki_search or wiki_read_page) — use wiki_create_page for a page that does not exist yet. ' +
      'Use dryRun to preview the change as a diff without writing.',
    schema: WikiUpdatePageSchema,
  },
);
