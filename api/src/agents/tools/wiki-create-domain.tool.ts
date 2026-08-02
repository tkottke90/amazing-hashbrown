import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getWikiRegistry } from '../../services/wiki.js';
import { getActiveSseWriter } from '../active-sse-writer.js';

const WikiCreateDomainSchema = z.object({
  wikiId: z
    .string()
    .describe(
      'Short identifier for the new domain (used as the directory name, e.g. "homelab", "recipes").',
    ),
  name: z
    .string()
    .optional()
    .describe('Human-readable display name. Defaults to wikiId if omitted.'),
  domain: z
    .string()
    .describe(
      'One-sentence description of what this domain covers. Written into SCHEMA.md and used for routing.',
    ),
  routingNotes: z
    .array(z.string())
    .optional()
    .describe('Routing hints added to the global registry to help the agent route to this domain.'),
});

export const wikiCreateDomainTool = tool(
  async ({ wikiId, name, domain, routingNotes }, config) => {
    let registry;
    try {
      registry = await getWikiRegistry();
    } catch {
      return 'Wiki knowledge base is not available.';
    }
    try {
      await registry.create({ id: wikiId, name, domain, routingNotes });
      const threadId = (config?.configurable?.thread_id as string | undefined) ?? '';
      getActiveSseWriter(threadId)?.({ type: 'wiki_domain_created', wikiId });
      return [
        `Created and registered wiki domain "${wikiId}". The directory and SCHEMA.md have been scaffolded. It is now available for routing and loading.`,
        ``,
        `[WIKI_ONBOARDING_SKILL]`,
        `You have created a new wiki. Begin a guided onboarding conversation to make it useful from day one. Work through these steps across multiple turns — do not rush to finish in one response:`,
        ``,
        `1. Orient — Call wiki_orient for "${wikiId}" to load the domain context before writing anything.`,
        `2. Understand — Ask the user to describe in their own words what they want this wiki to help them with. What knowledge do they currently keep in their head, in scattered notes, or have to re-research every time?`,
        `3. Discover — Ask for 3–5 specific examples of things they'd want documented first. Adapt your question to the domain they described (e.g. "What servers or services do you run?" for a homelab wiki; "What dishes do you make often?" for a recipes wiki).`,
        `4. Capture — For each example they give, create a page immediately using wiki_create_page. Don't wait until you have all examples — create as you go and ask follow-up questions to fill in details.`,
        `5. Taxonomy — After creating the initial pages, review what categories and tags have emerged naturally. Update SCHEMA.md to codify a tag taxonomy that will help organize future content.`,
        `6. Close — Tell the user what is now in their wiki (list the pages you created) and invite them to keep adding by telling you things they want to remember.`,
        ``,
        `Drive the conversation. Ask questions. Do not wait for the user to volunteer structure.`,
      ].join('\n');
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('already registered')) return `Wiki "${wikiId}" is already registered.`;
      throw err;
    }
  },
  {
    name: 'wiki_create_domain',
    description:
      'Scaffold a brand-new wiki domain on disk AND register it in one step. ' +
      'Creates the directory, writes SCHEMA.md, and adds the domain to the registry. ' +
      'Use this when the user wants to create a new knowledge domain from scratch. ' +
      'Do NOT use this for a domain that already exists on disk — use wiki_register_domain instead.',
    schema: WikiCreateDomainSchema,
  },
);
