// Thin wiring between the app and the framework-agnostic @tkottke90/llm-wiki
// mechanical layer. The library owns wiki mechanics; the app owns configuration.
//
// Construction is lazy so importing this module has no side effects (the
// registry creates its wikiRoot directory on first use, not at boot).

import { access } from 'node:fs/promises';
import path from 'node:path';
import { createWikiRegistry, type CreateWikiInput, type WikiRegistry } from '@tkottke90/llm-wiki';
import { OllamaEmbeddingProvider } from '@tkottke90/llm-wiki/providers';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

// Domains scaffolded automatically if missing on boot. Checked individually
// so an existing install that only has "user" still picks up new defaults.
const DEFAULT_DOMAINS: CreateWikiInput[] = [
  {
    id: 'user',
    name: 'User',
    domain: 'user',
    tags: [],
    routingNotes: ['user preferences, personal context, and biography -> user'],
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
 * registered and registers the app-docs wiki when its pre-built directory is
 * present. Idempotent — safe to call on every start.
 */
export async function bootKnowledgeBase(): Promise<void> {
  const registry = await getWikiRegistry();
  const existingIds = new Set(registry.list(true).map((w) => w.id));

  for (const input of DEFAULT_DOMAINS) {
    if (existingIds.has(input.id)) continue;
    await registry.create(input);
    logger.info('Knowledge base initialised', { wiki: input.id });
  }

  // app-docs is a read-only wiki generated from docs/app-wiki/ and bundled
  // into the Docker image at lib/assets/app-wiki/. Register it when the
  // pre-built directory is present; skip silently with a warning when not
  // (e.g. a dev environment before wiki:generate has been run).
  if (!existingIds.has('app-docs')) {
    const appWikiPath = path.resolve(process.cwd(), './lib/assets/app-wiki');
    try {
      await access(appWikiPath);
      await registry.register('app-docs', {
        domain: 'application configuration, features, providers, wiki, and how-to guides',
        tags: ['documentation', 'application'],
        status: 'readOnly',
        path: appWikiPath,
        routingNotes: [
          'how to configure the application -> app-docs',
          'how to use a feature -> app-docs',
          'application providers, settings, MCP, wiki, skills -> app-docs',
        ],
      });
      logger.info('Knowledge base initialised', { wiki: 'app-docs' });
    } catch {
      logger.warn('app-docs wiki not found — run npm run wiki:generate to build it', {
        path: appWikiPath,
      });
    }
  }

  logger.info('Knowledge base ready', { wikis: registry.list().map((w) => w.id) });
}
