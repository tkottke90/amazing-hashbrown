import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getWikiRegistry } from '../../services/wiki.js';

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
  async ({ wikiId, name, domain, routingNotes }) => {
    let registry;
    try {
      registry = await getWikiRegistry();
    } catch {
      return 'Wiki knowledge base is not available.';
    }
    try {
      await registry.create({ id: wikiId, name, domain, routingNotes });
      return `Created and registered wiki domain "${wikiId}". The directory and SCHEMA.md have been scaffolded. It is now available for routing and loading.`;
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
