import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getWikiRegistry } from '../../services/wiki.js';

const WikiLocateSchema = z.object({
  context: z
    .string()
    .optional()
    .describe(
      'Free-text description of the topic or task to match against a wiki domain. ' +
        'Omit to browse all registered domains and their routing hints instead.',
    ),
});

export const wikiLocateTool = tool(
  async ({ context }) => {
    let registry;
    try {
      registry = await getWikiRegistry();
    } catch {
      return 'Wiki knowledge base is not available.';
    }

    const wikis = registry.list();
    if (wikis.length === 0) return 'No wiki domains are configured.';

    if (!context) {
      const notes = registry.routingNotes();
      const domainLines = wikis.map(
        (w) =>
          `- ${w.id} (domain: ${w.domain}${w.tags.length ? `, tags: ${w.tags.join(', ')}` : ''})`,
      );
      const noteLines = notes.length ? notes.map((n) => `- ${n}`).join('\n') : '(none recorded)';
      return `Registered domains:\n${domainLines.join('\n')}\n\nRouting hints:\n${noteLines}`;
    }

    const result = registry.resolve(context);

    if ('path' in result) {
      return `Best match: "${result.id}" (domain: ${result.domain}, score ${result.score}). Use wiki_orient({ wikiId: "${result.id}" }) to see what's inside.`;
    }
    if ('ambiguous' in result) {
      const ids = result.candidates.map((c) => c.id).join(', ');
      return `Multiple domains match equally well: ${ids}. Narrow the context, or ask the user to pick one.`;
    }
    return `No domain matches. Available domains: ${result.available.join(', ') || '(none)'}.`;
  },
  {
    name: 'wiki_locate',
    description:
      'Find which wiki domain matches a topic, using deterministic routing (id/domain/tag/routing-note hits) — ' +
      "a domain-level lookup, not a content search. Or list all domains and their routing hints if you don't have " +
      "a specific topic yet. Call this first when you don't already know a wikiId — before wiki_orient, " +
      'wiki_search, or wiki_read_page. Score reflects match strength: double digits is a strong signal (an id or ' +
      'routing-note hit); a lone score of 2-3 is a weak, single-tag coincidence — use judgement.',
    schema: WikiLocateSchema,
  },
);
