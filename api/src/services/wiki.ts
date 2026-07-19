// Thin wiring between the app and the framework-agnostic @tkottke90/llm-wiki
// mechanical layer. The library owns wiki mechanics; the app owns configuration.
//
// Construction is lazy so importing this module has no side effects (the
// registry creates its wikiRoot directory on first use, not at boot).

import path from 'node:path';
import { createWikiRegistry, type WikiRegistry } from '@tkottke90/llm-wiki';
import { OllamaEmbeddingProvider } from '@tkottke90/llm-wiki/providers';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

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
 * Boot the knowledge base at startup. Creates the initial "user" domain wiki
 * if no wikis are registered yet (idempotent — safe to call on every start).
 *
 * Future: domain creation will be available as a Task System action so users
 * can scaffold additional domains through the agent without restarting.
 */
export async function bootKnowledgeBase(): Promise<void> {
  const registry = await getWikiRegistry();
  const existing = registry.list();

  if (existing.length > 0) {
    logger.info('Knowledge base ready', { wikis: existing.map((w: { id: string }) => w.id) });
    return;
  }

  await registry.create({
    id: 'user',
    name: 'User',
    domain: 'user',
    tags: [],
    routingNotes: ['user preferences, personal context, and biography -> user'],
  });

  logger.info('Knowledge base initialised', { wiki: 'user' });
}
