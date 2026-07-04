// Thin wiring between the app and the framework-agnostic @tkottke90/llm-wiki
// mechanical layer. The library owns wiki mechanics; the app owns configuration.
//
// Construction is lazy so importing this module has no side effects (the
// registry creates its wikiRoot directory on first use, not at boot).

import path from 'node:path';
import { createWikiRegistry, type WikiRegistry } from '@tkottke90/llm-wiki';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

let registryPromise: Promise<WikiRegistry> | undefined;

/** Resolve (and lazily construct) the singleton WikiRegistry for this process. */
export function getWikiRegistry(): Promise<WikiRegistry> {
  registryPromise ??= createWikiRegistry({
    wikiRoot: path.resolve(process.cwd(), env.wikiRoot ?? './config/kb'),
    logger,
  });
  return registryPromise;
}
