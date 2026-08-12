import { tool } from '@langchain/core/tools';
import matter from 'gray-matter';
import { z } from 'zod';
import { createWikiPage } from '../../services/wiki-write.js';
import { getActiveSseWriter } from '../active-sse-writer.js';

const WikiCreatePageSchema = z.object({
  wikiId: z
    .string()
    .describe('Wiki domain ID to create the page in, from wiki_locate or wiki_search.'),
  title: z.string().describe('Page title.'),
  corpus: z
    .union([
      z.object({ raw: z.string() }).describe('Inline markdown body (no frontmatter).'),
      z
        .object({ threadId: z.string(), toolKey: z.string() })
        .describe(
          'KV reference from a compact stub — copy threadId and toolKey verbatim from the stub.',
        ),
    ])
    .describe('Page content, either inline or as a KV reference from a compact stub.'),
  section: z
    .enum(['entity', 'concept', 'comparison', 'query', 'summary'])
    .describe(
      '"entity" for a specific person/place/thing/organization, "concept" for an idea, ' +
        '"comparison" for content contrasting two or more things, "query" for a captured ' +
        'question-and-answer, "summary" for a higher-level rollup.',
    ),
  tags: z.array(z.string()).optional().describe('Tags for the new page.'),
  confidence: z
    .enum(['high', 'medium', 'low'])
    .optional()
    .describe("How reliable this page's content is."),
  contested: z.boolean().optional().describe('True when the information on this page is disputed.'),
  contradictions: z.array(z.string()).optional().describe('Page paths this page contradicts.'),
  dryRun: z
    .boolean()
    .optional()
    .describe('If true, report what would be created without writing anything.'),
  force: z
    .boolean()
    .optional()
    .describe(
      'Skip duplicate detection and force creation. Only use after reading the blocking page ' +
        'with wiki_read_page and confirming it covers a genuinely different topic.',
    ),
});

export const wikiCreatePageTool = tool(
  async (
    { wikiId, title, corpus, section, tags, confidence, contested, contradictions, dryRun, force },
    config,
  ) => {
    if (!('raw' in corpus)) {
      return `[KV reference accepted — threadId: ${corpus.threadId}, toolKey: ${corpus.toolKey}. Full content fetch not yet implemented; re-call with corpus.raw once the KV store is available.]`;
    }
    const result = await createWikiPage({
      wikiId,
      title,
      content: matter(corpus.raw).content,
      section,
      tags,
      confidence,
      contested,
      contradictions,
      dryRun,
      force,
    });

    switch (result.status) {
      case 'written': {
        const threadId = config?.configurable?.thread_id as string | undefined;
        getActiveSseWriter(threadId ?? '')?.({
          type: 'wiki_updated',
          pageTitle: title,
          pageKind: section,
          wikiName: wikiId,
        });
        return `Created page "${title}" at ${result.result.path}.`;
      }
      case 'dry_run':
        return `[dry run] Would create a new "${result.section}" page titled "${result.title}" in wiki "${result.wikiId}".`;
      case 'duplicate':
        return (
          `A similar page already exists: "${result.existingTitle}" at ${result.existingPath}. ` +
          `Read it with wiki_read_page, then take one of these two actions:\n` +
          `(1) Same topic — call wiki_update_page with mode:"append" and pass only the new sections as content. Do NOT rewrite the entire page.\n` +
          `(2) Genuinely different document (different format, version, or use case) — retry wiki_create_page with force:true and include an additional distinguishing term in the title.\n` +
          `Do NOT retry wiki_create_page without force:true, and do not vary the title to work around this check.`
        );
      case 'wiki_unavailable':
        return 'Wiki knowledge base is not available.';
      case 'unknown_wiki':
        return `Wiki "${result.wikiId}" is not registered. Use wiki_locate to find available domains.`;
    }
  },
  {
    name: 'wiki_create_page',
    description:
      'Create a new wiki page. If a similar page already exists, this returns a pointer to it ' +
      'instead of writing — read it with wiki_read_page and call wiki_update_page with merged ' +
      'content instead of creating a duplicate. Use dryRun to preview without writing.',
    schema: WikiCreatePageSchema,
  },
);
