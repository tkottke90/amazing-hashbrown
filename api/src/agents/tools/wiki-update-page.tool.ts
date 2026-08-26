import { tool } from '@langchain/core/tools';
import matter from 'gray-matter';
import { z } from 'zod';
import { updateWikiPage } from '../../services/wiki-write.js';
import { getActiveSseWriter } from '../active-sse-writer.js';
import { wikiWriteForbiddenMessage } from './wiki-write-guard.js';

const WikiUpdatePageSchema = z.object({
  wikiId: z.string().describe('Wiki domain ID the page belongs to.'),
  path: z
    .string()
    .describe('Existing page path relative to the wiki root, from wiki_search or wiki_read_page.'),
  content: z
    .string()
    .describe(
      'Page body as markdown (no frontmatter). With mode "replace" (default): the full replacement body. ' +
        'With mode "append": only the new content to add — it is appended after the existing body.',
    ),
  mode: z
    .enum(['replace', 'append'])
    .optional()
    .describe(
      '"replace" (default): content replaces the entire page body. ' +
        '"append": content is added after the existing body — use this when merging new sections ' +
        'from a separate article rather than rewriting the whole page.',
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe('Replacement tag list. Omit to preserve the existing tags.'),
  // "the only way to set it" clause added after auto-eval round 3 (wiki-lint,
  // 2026-07-28): asked to fix a missing-confidence quality finding, glm and
  // local both reasoned "add confidence: high" but passed no confidence param
  // — apparently writing frontmatter into `content` instead, which the
  // content param explicitly excludes. The description now closes that path.
  //
  // Sentence added after auto-eval round 1 of wiki-lint against a new
  // Ornith build (2026-08-26): Ornith's reasoning explicitly decided on a
  // confidence value ("I'll set it to a reasonable value") but then called
  // the tool without the confidence param at all — not writing it into
  // content either, just dropping it. The decision-in-reasoning wasn't
  // wrong, it just never reached the actual call.
  //
  // Final sentence added after round 2 of the same loop: with the sentence
  // above in place, `local` (gpt-oss:20b) hit a *different* failure on the
  // same scenario — instead of deciding a value and dropping it, it got
  // stuck on "we don't know user preference" and called wiki_search to look
  // for a precedent instead of ever calling wiki_update_page. Nothing told
  // it this is a judgment call it's expected to make from the content
  // itself, not a fact to look up. NOTE: this sentence is not expected to
  // fix Ornith's round-1/round-2 dropped-param failure on this same
  // scenario — that recurred in the identical shape right after a targeted
  // fix and is logged as a capability ceiling, not a wording gap.
  confidence: z
    .enum(['high', 'medium', 'low'])
    .optional()
    .describe(
      "How reliable this page's content is. Omit to preserve the existing value. " +
        'This param is the only way to set the confidence frontmatter field — writing ' +
        'frontmatter into `content` does not work. Deciding on a value while reasoning is ' +
        'not enough — the finding stays unresolved until that value is actually passed here. ' +
        "This is your own judgment of the content's reliability based on what it actually " +
        'says — plain factual statements typically warrant medium or high. There is no ' +
        'external precedent to search for; searching the wiki for other pages\' confidence ' +
        'values does not help decide this one.',
    ),
  contested: z
    .boolean()
    .optional()
    .describe('Whether this information is disputed. Omit to preserve the existing value.'),
  contradictions: z
    .array(z.string())
    .optional()
    .describe('Page paths this page contradicts. Omit to preserve the existing value.'),
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

export function makeWikiUpdatePageTool(allowedWikiId?: string) {
  return tool(
    async (
      { wikiId, path, content, mode, tags, confidence, contested, contradictions, summary, dryRun },
      config,
    ) => {
      const result = await updateWikiPage(
        {
          wikiId,
          path,
          content: matter(content).content,
          mode,
          tags,
          confidence,
          contested,
          contradictions,
          summary,
          dryRun,
        },
        undefined,
        allowedWikiId,
      );

      switch (result.status) {
        case 'written': {
          const threadId = config?.configurable?.thread_id as string | undefined;
          getActiveSseWriter(threadId ?? '')?.({
            type: 'wiki_updated',
            pageTitle: path,
            pageKind: 'updated',
            wikiName: wikiId,
          });
          const warnings = result.result.warnings.map((w) => w.message).join(' ');
          const deletedWarning =
            result.deletedSections.length > 0
              ? ` WARNING: the following sections were present in the previous version but are missing from the new content: ${result.deletedSections.map((s) => `"${s}"`).join(', ')}. If this was unintentional, re-read the page and rewrite it with all sections preserved.`
              : '';
          return `Updated page at ${result.result.path}.${warnings ? ` ${warnings}` : ''}${deletedWarning}`;
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
        case 'wiki_forbidden':
          return wikiWriteForbiddenMessage(result.wikiId, result.allowedWikiId);
      }
    },
    {
      name: 'wiki_update_page',
      description:
        "Update an existing wiki page's content. Requires the page's existing path (from " +
        'wiki_search or wiki_read_page) — use wiki_create_page for a page that does not exist yet. ' +
        'Use mode:"append" to add new sections after the existing body without rewriting the whole page. ' +
        'Use dryRun to preview the change as a diff without writing.',
      schema: WikiUpdatePageSchema,
    },
  );
}
