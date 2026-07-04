/**
 * WikiRegistry — the multi-wiki handle. Owns `<wikiRoot>/registry.json`,
 * performs deterministic scored routing, and coordinates wiki creation.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { LintReport, Logger, RegistryFile, ResolveResult, WikiEntry } from './types.js';
import { computeRouting } from './internal/routing.js';
import { SCHEMA_FILE } from './internal/paths.js';
import { LlmWiki } from './llm-wiki.js';

const REGISTRY_FILE = 'registry.json';

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const WikiEntrySchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  domain: z.string().default(''),
  tags: z.array(z.string()).default([]),
  status: z.enum(['active', 'archived']).default('active'),
});

const RegistrySchema = z.object({
  version: z.number().default(1),
  wikis: z.array(WikiEntrySchema).default([]),
  routingNotes: z.array(z.string()).default([]),
});

export interface CreateWikiRegistryOptions {
  wikiRoot: string;
  logger?: Logger;
}

export interface CreateWikiInput {
  id: string;
  name?: string;
  domain: string;
  tags?: string[];
  routingNotes?: string[];
  /** Path relative to the wiki root; defaults to the id. */
  path?: string;
}

export class WikiRegistry {
  private constructor(
    readonly wikiRoot: string,
    private data: RegistryFile,
    private readonly logger: Logger,
  ) {}

  /** Construct a registry, loading `<wikiRoot>/registry.json` if it exists. */
  static async create(opts: CreateWikiRegistryOptions): Promise<WikiRegistry> {
    const logger = opts.logger ?? noopLogger;
    const root = path.resolve(opts.wikiRoot);
    await fs.mkdir(root, { recursive: true });

    const registryPath = path.join(root, REGISTRY_FILE);
    let data: RegistryFile;
    try {
      const raw = await fs.readFile(registryPath, 'utf8');
      data = RegistrySchema.parse(JSON.parse(raw));
    } catch {
      data = { version: 1, wikis: [], routingNotes: [] };
    }
    return new WikiRegistry(root, data, logger);
  }

  // ── Routing / lookup ────────────────────────────────────────────────────────

  /** Score every active wiki against free-text context and pick a match. */
  resolve(context: string): ResolveResult {
    const result = computeRouting(this.data.wikis, this.data.routingNotes, context);
    if (result.kind === 'match') {
      const { entry, score } = result.winner!;
      return { path: this.resolvePath(entry), id: entry.id, domain: entry.domain, score };
    }
    if (result.kind === 'ambiguous') {
      return {
        ambiguous: true,
        candidates: result.candidates!.map((e) => ({
          id: e.id,
          path: this.resolvePath(e),
        })),
      };
    }
    return { noMatch: true, available: (result.available ?? []).map((e) => e.id) };
  }

  /** All registered wikis (active only by default). */
  list(includeArchived = false): WikiEntry[] {
    return includeArchived
      ? [...this.data.wikis]
      : this.data.wikis.filter((w) => w.status === 'active');
  }

  /** The current routing notes. */
  routingNotes(): string[] {
    return [...this.data.routingNotes];
  }

  /** Load a registered wiki by id. */
  async load(id: string): Promise<LlmWiki> {
    const entry = this.entry(id);
    return LlmWiki.load(this.resolvePath(entry), { logger: this.logger });
  }

  /** Resolve free-text context and load the matched wiki when unambiguous. */
  async resolveOrLoad(context: string): Promise<LlmWiki | ResolveResult> {
    const result = this.resolve(context);
    if ('path' in result) return this.load(result.id);
    return result;
  }

  // ── Mutation ────────────────────────────────────────────────────────────────

  /** Scaffold a new wiki and register it. */
  async create(input: CreateWikiInput): Promise<LlmWiki> {
    if (this.data.wikis.some((w) => w.id === input.id)) {
      throw new Error(`Wiki id already registered: ${input.id}`);
    }
    const relPath = input.path ?? input.id;
    const absPath = path.isAbsolute(relPath) ? relPath : path.join(this.wikiRoot, relPath);

    const wiki = await LlmWiki.create({
      path: absPath,
      name: input.name ?? input.id,
      domain: input.domain,
      tags: input.tags,
      logger: this.logger,
    });

    this.data.wikis.push({
      id: input.id,
      path: relPath,
      domain: input.domain,
      tags: input.tags ?? [],
      status: 'active',
    });
    if (input.routingNotes?.length) {
      this.data.routingNotes.push(...input.routingNotes);
    }
    await this.persist();
    return wiki;
  }

  /** Replace the routing notes and persist. */
  async saveRoutingNotes(notes: string[]): Promise<void> {
    this.data.routingNotes = [...notes];
    await this.persist();
  }

  // ── Health ──────────────────────────────────────────────────────────────────

  /** Lint a wiki, injecting registry data so registry_sync can run. */
  async lint(id: string): Promise<LintReport> {
    const wiki = await this.load(id);
    return wiki.lint({
      wikiIds: this.data.wikis.map((w) => w.id),
      onDiskDirs: await this.onDiskWikiDirs(),
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private entry(id: string): WikiEntry {
    const entry = this.data.wikis.find((w) => w.id === id);
    if (!entry) throw new Error(`Wiki not registered: ${id}`);
    return entry;
  }

  private resolvePath(entry: WikiEntry): string {
    return path.isAbsolute(entry.path) ? entry.path : path.join(this.wikiRoot, entry.path);
  }

  /** Directory names directly under wikiRoot that contain a SCHEMA.md. */
  private async onDiskWikiDirs(): Promise<string[]> {
    const dirs: string[] = [];
    let entries;
    try {
      entries = await fs.readdir(this.wikiRoot, { withFileTypes: true });
    } catch {
      return dirs;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await fs.access(path.join(this.wikiRoot, entry.name, SCHEMA_FILE));
        dirs.push(entry.name);
      } catch {
        // not a wiki directory
      }
    }
    return dirs;
  }

  /** Persist registry.json atomically (write temp, then rename). */
  private async persist(): Promise<void> {
    const target = path.join(this.wikiRoot, REGISTRY_FILE);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, target);
    this.logger.debug('Persisted registry.json');
  }
}

/** Primary library entry point — construct a registry from app config. */
export async function createWikiRegistry(opts: CreateWikiRegistryOptions): Promise<WikiRegistry> {
  return WikiRegistry.create(opts);
}
