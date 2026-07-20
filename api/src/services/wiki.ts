// Thin wiring between the app and the framework-agnostic @tkottke90/llm-wiki
// mechanical layer. The library owns wiki mechanics; the app owns configuration.
//
// Construction is lazy so importing this module has no side effects (the
// registry creates its wikiRoot directory on first use, not at boot).

import path from 'node:path';
import { createWikiRegistry, type CreateWikiInput, type WikiRegistry } from '@tkottke90/llm-wiki';
import { OllamaEmbeddingProvider } from '@tkottke90/llm-wiki/providers';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

// Domains scaffolded automatically if missing on boot. Checked individually
// (rather than bailing out when any wiki exists) so an existing install that
// only has "user" still picks up "self" once this ships.
const DEFAULT_DOMAINS: CreateWikiInput[] = [
  {
    id: 'user',
    name: 'User',
    domain: 'user',
    tags: [],
    routingNotes: ['user preferences, personal context, and biography -> user'],
  },
  {
    id: 'self',
    name: 'Self',
    domain: 'agent identity, values, decisions, and reflection',
    tags: [],
    routingNotes: [
      "the agent's own reasoning, values, principles, decisions, mistakes, and growth -> self",
    ],
  },
];

let registryPromise: Promise<WikiRegistry> | undefined;

/** Resolve (and lazily construct) the singleton WikiRegistry for this process. */
export function getWikiRegistry(): Promise<WikiRegistry> {
  registryPromise ??= createWikiRegistry({
    wikiRoot: path.resolve(process.cwd(), env.wikiRoot ?? './config/kb'),
    logger,
    embeddingProvider: env.embeddings.enabled
      ? new OllamaEmbeddingProvider({
          baseUrl: env.embeddings.baseUrl,
          model: env.embeddings.model,
        })
      : undefined,
  });
  return registryPromise;
}

/**
 * Boot the knowledge base at startup. Creates any of DEFAULT_DOMAINS not yet
 * registered (idempotent — safe to call on every start).
 *
 * Future: domain creation will be available as a Task System action so users
 * can scaffold additional domains through the agent without restarting.
 */
export async function bootKnowledgeBase(): Promise<void> {
  const registry = await getWikiRegistry();
  const existingIds = new Set(registry.list().map((w) => w.id));

  for (const input of DEFAULT_DOMAINS) {
    if (existingIds.has(input.id)) continue;
    await registry.create(input);
    logger.info('Knowledge base initialised', { wiki: input.id });
  }

  logger.info('Knowledge base ready', { wikis: registry.list().map((w) => w.id) });
}
