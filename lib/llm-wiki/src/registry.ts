/**
 * WikiRegistry — the multi-wiki handle. Owns `<wikiRoot>/registry.json`,
 * performs deterministic scored routing, and coordinates wiki creation.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type {
  EmbeddingAdapter,
  LintReport,
  Logger,
  RegistryFile,
  ResolveResult,
  WikiEntry,
} from './types.js';
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
  /** Shared across every wiki this registry loads/creates. Omit to fall back
   * to keyword-only search (see LlmWiki.semanticSearch). */
  embeddingProvider?: EmbeddingAdapter;
}

export interface CreateWikiInput {
  id: string;
  name?: string;
  domain: string;
  tags?: string[];
  routingNotes?: string[];
  /** Path relative to the wiki root; defaults to the id. */
  path?: string;
  /** YAML frontmatter written into the scaffolded index.md (e.g. ephemeral
   * lifecycle markers). Never stored in registry.json. */
  metadata?: Record<string, string>;
}

export class WikiRegistry {
  private constructor(
    readonly wikiRoot: string,
    private data: RegistryFile,
    private readonly logger: Logger,
    private readonly embeddingProvider?: EmbeddingAdapter,
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
    return new WikiRegistry(root, data, logger, opts.embeddingProvider);
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
    return LlmWiki.load(this.resolvePath(entry), {
      logger: this.logger,
      embeddingProvider: this.embeddingProvider,
    });
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
    const relPath = input.path ?? input.id;
    const absPath = path.isAbsolute(relPath) ? relPath : path.join(this.wikiRoot, relPath);

    const wiki = await LlmWiki.create({
      path: absPath,
      name: input.name ?? input.id,
      domain: input.domain,
      tags: input.tags,
      metadata: input.metadata,
      logger: this.logger,
      embeddingProvider: this.embeddingProvider,
    });

    await this.register(input.id, {
      domain: input.domain,
      tags: input.tags,
      routingNotes: input.routingNotes,
    });
    return wiki;
  }

  /**
   * Register an already-existing on-disk wiki directory in registry.json.
   * Reads the domain from the directory's SCHEMA.md automatically.
   */
  async register(
    id: string,
    opts?: { domain?: string; tags?: string[]; routingNotes?: string[] },
  ): Promise<void> {
    if (this.data.wikis.some((w) => w.id === id)) {
      throw new Error(`Wiki id already registered: ${id}`);
    }
    const wikiDir = path.join(this.wikiRoot, id);
    try {
      await fs.access(path.join(wikiDir, SCHEMA_FILE));
    } catch {
      throw new Error(`Wiki directory not found or missing SCHEMA.md: ${id}`);
    }
    let parsedDomain = '';
    try {
      const schema = await fs.readFile(path.join(wikiDir, SCHEMA_FILE), 'utf8');
      const m = schema.match(/##\s*Domain\s*\n([\s\S]*?)(?=\n##|\n#|$)/);
      if (m?.[1]) parsedDomain = m[1].trim();
    } catch {
      /* fall back to empty string */
    }
    const domain = opts?.domain ?? parsedDomain;
    this.data.wikis.push({ id, path: id, domain, tags: opts?.tags ?? [], status: 'active' });
    if (opts?.routingNotes?.length) this.data.routingNotes.push(...opts.routingNotes);
    await this.persist();
  }

  /** Replace the routing notes and persist. */
  async saveRoutingNotes(notes: string[]): Promise<void> {
    this.data.routingNotes = [...notes];
    await this.persist();
  }

  /** Remove a registered wiki from registry.json. Does not touch disk files —
   * see destroy() for the variant that also deletes the wiki directory. */
  async remove(id: string): Promise<void> {
    this.data.wikis = this.data.wikis.filter((w) => w.id !== id);
    await this.persist();
  }

  /** Mark a registered wiki archived: excluded from list()'s default
   * (active-only) results and from routing, but still load()-able by id.
   * Does not touch the wiki's own index.md — see LlmWiki.archive() for that
   * independent, disk-level marker. */
  async archive(id: string): Promise<void> {
    const entry = this.entry(id);
    entry.status = 'archived';
    await this.persist();
  }

  /**
   * Delete a wiki's directory from disk, then remove its registry entry.
   * Tolerates a wiki that was scaffolded but never registered (or only
   * half-registered) so callers can use it to roll back a failed create.
   */
  async destroy(id: string): Promise<void> {
    const entry = this.data.wikis.find((w) => w.id === id);
    let target: string;
    if (entry) {
      target = this.resolvePath(entry);
    } else {
      // Unregistered id: the directory convention is <wikiRoot>/<id>. Refuse
      // ids that resolve outside the wiki root — id becomes a path segment.
      target = path.join(this.wikiRoot, id);
      if (path.dirname(target) !== this.wikiRoot) {
        this.logger.warn(`destroy(${id}): id escapes wiki root, skipping disk delete`);
        await this.remove(id);
        return;
      }
    }
    await fs.rm(target, { recursive: true, force: true });
    await this.remove(id);
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
