import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getWikiRegistry } from '../../services/wiki.js';

const WikiRegisterDomainSchema = z.object({
  wikiId: z
    .string()
    .describe(
      'Directory name of the unregistered wiki — from the registry_sync lint finding message.',
    ),
  routingNotes: z
    .array(z.string())
    .optional()
    .describe(
      'Routing hints to append to the global registry to help the agent route to this domain.',
    ),
});

export const wikiRegisterDomainTool = tool(
  async ({ wikiId, routingNotes }) => {
    let registry;
    try {
      registry = await getWikiRegistry();
    } catch {
      return 'Wiki knowledge base is not available.';
    }
    try {
      await registry.register(wikiId, { routingNotes });
      return `Registered wiki domain "${wikiId}". It is now available for routing and loading.`;
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('already registered')) return `Wiki "${wikiId}" is already registered.`;
      if (msg.includes('not found or missing')) {
        return `Directory "${wikiId}" does not exist or is missing SCHEMA.md. Cannot register.`;
      }
      throw err;
    }
  },
  {
    name: 'wiki_register_domain',
    description:
      'Register an existing on-disk wiki directory in the registry. Use to fix registry_sync ' +
      "findings from wiki_lint. The domain is read automatically from the directory's SCHEMA.md. " +
      'Does not scaffold — the directory must already exist.',
    schema: WikiRegisterDomainSchema,
  },
);
