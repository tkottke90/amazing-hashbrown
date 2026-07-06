/**
 * LlmWiki — the coarse, deterministic "tool surface" for one wiki directory.
 *
 * Each method hides a full mechanical sequence and returns structured,
 * JSON-serializable results, so a future LLM layer can operate the wiki without
 * knowing the internal steps. No LLM, no network — source content is passed in.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  CommitResult,
  GraphEdge,
  GraphNode,
  GraphResult,
  IngestPrep,
  LintReport,
  Logger,
  OrientResult,
  PageInput,
  Warning,
  WikiFile,
} from './types.js';
import * as fm from './internal/frontmatter.js';
import * as nav from './internal/nav.js';
import {
  INDEX_FILE,
  LOG_FILE,
  SCHEMA_FILE,
  WIKI_DIRS,
  WIKI_SUBDIRS,
  isoToday,
  pagePathFor,
  slugify,
  suggestRawPath,
} from './internal/paths.js';
import { sha256Body } from './internal/sha.js';
import { extractWikilinks, outboundLinkCount, pageStem, resolveLinkTarget } from './internal/wikilinks.js';
import {
  runLint,
  type LintContext,
  type LintPage,
  type LintRawFile,
} from './internal/lint/index.js';
import { schemaTemplate, indexTemplate, logTemplate } from './internal/templates.js';

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const RECENT_LOG_COUNT = 30;
const MIN_OUTBOUND_LINKS = 2;

export interface CreateOptions {
  path: string;
  name: string;
  domain: string;
  tags?: string[];
  logger?: Logger;
}

export interface LoadOptions {
  logger?: Logger;
}

export interface SaveRawOptions {
  content: string;
  sourceUrl: string;
  sha256: string;
  /** Explicit path relative to the wiki root; defaults to a suggested raw path. */
  path?: string;
}

export interface IngestPrepInput {
  content: string;
  url?: string;
  filename?: string;
  keywords?: string[];
}

export interface BuildGraphOptions {
  /** When true, raw source files become nodes and derived_from edges are included. Default false. */
  includeSources?: boolean;
}

export class LlmWiki {
  private readonly logger: Logger;
  private taxonomy: Set<string>;

  private constructor(
    readonly basePath: string,
    taxonomy: Set<string>,
    logger: Logger,
  ) {
    this.taxonomy = taxonomy;
    this.logger = logger;
  }

  // ── Factories ──────────────────────────────────────────────────────────────

  /** Scaffold a new wiki: directory structure + SCHEMA/index/log skeletons. */
  static async create(opts: CreateOptions): Promise<LlmWiki> {
    const logger = opts.logger ?? noopLogger;
    const base = path.resolve(opts.path);
    const today = isoToday();
    const ctx = { name: opts.name, domain: opts.domain, tags: opts.tags ?? [], today };

    for (const dir of WIKI_DIRS) {
      await fs.mkdir(path.join(base, dir), { recursive: true });
    }
    await fs.mkdir(path.join(base, 'raw', 'articles'), { recursive: true });

    await writeIfAbsent(path.join(base, SCHEMA_FILE), schemaTemplate(ctx));
    await writeIfAbsent(path.join(base, INDEX_FILE), indexTemplate(ctx));
    await writeIfAbsent(path.join(base, LOG_FILE), logTemplate(ctx));

    logger.info(`Created wiki at ${base}`);
    return LlmWiki.load(base, { logger });
  }

  /** Load an existing wiki, parsing its SCHEMA.md tag taxonomy into memory. */
  static async load(wikiPath: string, opts: LoadOptions = {}): Promise<LlmWiki> {
    const logger = opts.logger ?? noopLogger;
    const base = path.resolve(wikiPath);
    const schema = await readFileOr(path.join(base, SCHEMA_FILE), '');
    return new LlmWiki(base, fm.parseTaxonomy(schema), logger);
  }

  // ── Read / orient ───────────────────────────────────────────────────────────

  /** Load the wiki's current state: schema, index, and recent log entries. */
  async orient(recent = RECENT_LOG_COUNT): Promise<OrientResult> {
    const [schema, index, log] = await Promise.all([
      readFileOr(this.abs(SCHEMA_FILE), ''),
      readFileOr(this.abs(INDEX_FILE), ''),
      readFileOr(this.abs(LOG_FILE), ''),
    ]);
    return { schema, index, recentLog: nav.parseRecentLog(log, recent) };
  }

  /** Return content-page paths whose text matches any of the given terms. */
  async search(terms: string[]): Promise<string[]> {
    const needles = terms.map((t) => t.toLowerCase()).filter(Boolean);
    if (needles.length === 0) return [];
    const paths = await this.listContentPaths();
    const matches: string[] = [];
    for (const rel of paths) {
      const content = (await readFileOr(this.abs(rel), '')).toLowerCase();
      if (needles.some((n) => content.includes(n))) matches.push(rel);
    }
    return matches;
  }

  /** List all content pages as parsed WikiFiles. */
  async listPages(): Promise<WikiFile[]> {
    const paths = await this.listContentPaths();
    return Promise.all(paths.map((rel) => this.readPage(rel)));
  }

  /** Read and parse a single page by its path relative to the wiki root. */
  async readPage(relPath: string): Promise<WikiFile> {
    const raw = await fs.readFile(this.abs(relPath), 'utf8');
    const stat = await fs.stat(this.abs(relPath));
    const { data, body } = fm.parse(raw);
    const frontmatter = fm.toFrontmatter(data);
    return {
      filename: relPath,
      title: frontmatter.title || pageStem(relPath),
      type: frontmatter.type,
      frontmatter,
      content: body,
      sha: sha256Body(raw),
      created: stat.birthtime,
      lastModified: stat.mtime,
    };
  }

  /** Build a graph of nodes and edges from the wiki's pages and their links. */
  async buildGraph(opts: BuildGraphOptions = {}): Promise<GraphResult> {
    const pages = await this.listPages();
    const allPaths = pages.map((p) => p.filename);

    const nodes: GraphResult['nodes'] = [];
    const edges: GraphResult['edges'] = [];
    const edgeSet = new Set<string>();
    const sourceNodeMap = new Map<string, GraphResult['nodes'][number]>();

    const addEdge = (source: string, target: string, type: GraphEdge['type']) => {
      const key = `${source}|${target}|${type}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push({ source, target, type });
      }
    };

    for (const page of pages) {
      const id = pageStem(page.filename);
      const node: GraphNode = { id, title: page.title, type: page.type, tags: page.frontmatter.tags };
      if (page.frontmatter.confidence !== undefined) node.confidence = page.frontmatter.confidence;
      if (page.frontmatter.contested !== undefined) node.contested = page.frontmatter.contested;
      nodes.push(node);

      for (const link of extractWikilinks(page.content)) {
        const resolved = resolveLinkTarget(link, allPaths);
        if (resolved && resolved !== page.filename) {
          addEdge(id, pageStem(resolved), 'references');
        }
      }

      for (const slug of page.frontmatter.contradictions ?? []) {
        const resolved = resolveLinkTarget(String(slug), allPaths);
        if (resolved && resolved !== page.filename) {
          addEdge(id, pageStem(resolved), 'contradicts');
        }
      }

      if (opts.includeSources) {
        for (const sourcePath of page.frontmatter.sources.filter(Boolean)) {
          const sourceId = pageStem(sourcePath);
          if (!sourceNodeMap.has(sourceId)) {
            const basename = sourcePath.split('/').pop()?.replace(/\.md$/i, '') ?? sourceId;
            sourceNodeMap.set(sourceId, { id: sourceId, title: basename, type: 'source', tags: [] });
          }
          addEdge(id, sourceId, 'derived_from');
        }
      }
    }

    if (opts.includeSources) {
      for (const sourceNode of sourceNodeMap.values()) {
        nodes.push(sourceNode);
      }
    }

    return { nodes, edges };
  }

  // ── Ingest ────────────────────────────────────────────────────────────────

  /** Pre-flight checks before ingesting a source: hash, drift, existing pages. */
  async ingestPrep(input: IngestPrepInput): Promise<IngestPrep> {
    const today = isoToday();
    const sha256 = sha256Body(input.content);
    const url = input.url?.trim() ?? '';

    let existingRaw: string | null = null;
    let storedSha256: string | null = null;
    let drift = false;

    if (url) {
      existingRaw = await this.findRawByUrl(url);
      if (existingRaw) {
        const raw = await readFileOr(this.abs(existingRaw), '');
        const stored = String(fm.parse(raw).data.sha256 ?? '').trim();
        storedSha256 = stored || null;
        drift = Boolean(stored) && stored !== sha256;
      }
    }

    let keywords = (input.keywords ?? []).filter((k) => k.trim());
    if (keywords.length === 0 && input.filename) {
      const stem = (input.filename.split('/').pop() ?? '').replace(/\.md$/i, '');
      keywords = stem
        .split(/[-_\s]+/)
        .filter((p) => p.length > 2)
        .slice(0, 6);
    }

    return {
      sha256,
      isNew: existingRaw === null,
      drift,
      existingRaw,
      storedSha256,
      existingPages: keywords.length ? await this.search(keywords) : [],
      suggestedRawPath: suggestRawPath({ url, filename: input.filename, today }),
    };
  }

  /** Write an immutable raw source file with provenance frontmatter. */
  async saveRawSource(opts: SaveRawOptions): Promise<{ path: string }> {
    const today = isoToday();
    const rel = opts.path ?? suggestRawPath({ url: opts.sourceUrl, today });
    const frontmatter = {
      source_url: opts.sourceUrl || `conversation:${today}`,
      ingested: today,
      sha256: opts.sha256,
    };
    await this.writeFileRel(rel, fm.serialize(frontmatter, opts.content));
    this.logger.debug(`Saved raw source ${rel}`);
    return { path: rel };
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * Upsert one wiki page: write it, update index.md, append a log entry.
   * Soft violations (few links, unknown tags) return warnings; malformed input
   * throws. Lint remains the authoritative health check.
   */
  async commitPage(page: PageInput): Promise<CommitResult> {
    if (!page.title.trim()) {
      throw new Error('commitPage: page.title is required.');
    }
    const today = isoToday();
    const rel = page.relPath ?? pagePathFor(page.type, page.title);

    const existing = await this.readRawOrNull(rel);
    const created = existing === null;
    const priorData = existing ? fm.parse(existing).data : {};

    const mergedSources = unique([...asStringArray(priorData.sources), ...page.sources]);
    const frontmatter = pruneUndefined({
      title: page.title,
      created: created ? today : String(priorData.created ?? today),
      updated: today,
      type: page.type,
      tags: page.tags,
      sources: mergedSources,
      confidence: page.confidence,
      contested: page.contested,
      contradictions: page.contradictions,
    });

    const missing = fm.missingRequired(frontmatter);
    if (missing.length) {
      throw new Error(`commitPage: missing required frontmatter: ${missing.join(', ')}.`);
    }

    await this.writeFileRel(rel, fm.serialize(frontmatter, page.body));

    // Update index.md with the new entry + refreshed meta.
    const paths = await this.listContentPaths();
    const summary = page.summary?.trim() || page.title;
    let index = await readFileOr(this.abs(INDEX_FILE), '');
    index = nav.upsertIndexEntry(index, {
      type: page.type,
      stem: pageStem(rel),
      title: page.title,
      summary,
    });
    index = nav.setIndexMeta(index, { today, totalPages: paths.length });
    await this.writeFileRel(INDEX_FILE, index);

    await this.appendLog({
      action: created ? 'ingest' : 'update',
      subject: page.title,
      files: [rel],
    });

    return { path: rel, created, warnings: this.pageWarnings(page, paths) };
  }

  /** Insert a `[[wikilink]]` to `toPage` under `fromPage`'s Related Pages. */
  async addCrossLink(opts: { fromPage: string; toPage: string }): Promise<CommitResult> {
    const raw = await this.readRawOrNull(opts.fromPage);
    if (raw === null) {
      throw new Error(`addCrossLink: page not found: ${opts.fromPage}`);
    }
    const today = isoToday();
    const { data, body } = fm.parse(raw);
    const targetStem = pageStem(opts.toPage);
    const link = `[[${targetStem}]]`;

    const warnings: Warning[] = [];
    let newBody = body;
    if (body.includes(link)) {
      warnings.push({ code: 'missing-related', message: 'Cross-link already present.' });
    } else {
      newBody = insertRelatedLink(body, link);
    }

    const frontmatter = pruneUndefined({ ...data, updated: today });
    await this.writeFileRel(opts.fromPage, fm.serialize(frontmatter, newBody));
    await this.appendLog({
      action: 'update',
      subject: `cross-link ${pageStem(opts.fromPage)} → ${targetStem}`,
    });
    return { path: opts.fromPage, created: false, warnings };
  }

  // ── Bookkeeping / health ────────────────────────────────────────────────────

  /** Append a `## [date] action | subject` entry to log.md. */
  async log(opts: { action: string; subject: string; files?: string[] }): Promise<void> {
    await this.appendLog(opts);
  }

  /** Run all applicable lint checks and return a structured report. */
  async lint(registry?: { wikiIds: string[]; onDiskDirs: string[] }): Promise<LintReport> {
    const ctx = await this.buildLintContext(registry);
    return runLint(ctx);
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private abs(rel: string): string {
    return path.join(this.basePath, rel);
  }

  private async writeFileRel(rel: string, content: string): Promise<void> {
    const target = this.abs(rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }

  private async readRawOrNull(rel: string): Promise<string | null> {
    return readFileOrNull(this.abs(rel));
  }

  private async appendLog(opts: {
    action: string;
    subject: string;
    files?: string[];
  }): Promise<void> {
    const entry = nav.formatLogEntry({ today: isoToday(), ...opts });
    const current = await readFileOr(this.abs(LOG_FILE), '');
    const separator = current.endsWith('\n') || current === '' ? '' : '\n';
    await this.writeFileRel(LOG_FILE, `${current}${separator}\n${entry}`);
  }

  /** Content-page paths (relative) across all wiki subdirectories. */
  private async listContentPaths(): Promise<string[]> {
    const out: string[] = [];
    for (const subdir of WIKI_SUBDIRS) {
      const dir = this.abs(subdir);
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names.sort()) {
        if (name.endsWith('.md') && !name.startsWith('_')) out.push(`${subdir}/${name}`);
      }
    }
    return out;
  }

  private async findRawByUrl(url: string): Promise<string | null> {
    const rawDir = this.abs('raw');
    const stack = [rawDir];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.name.endsWith('.md')) {
          const raw = await readFileOr(full, '');
          if (String(fm.parse(raw).data.source_url ?? '').trim() === url) {
            return path.relative(this.basePath, full);
          }
        }
      }
    }
    return null;
  }

  private pageWarnings(page: PageInput, paths: string[]): Warning[] {
    const warnings: Warning[] = [];
    const rel = page.relPath ?? pagePathFor(page.type, page.title);
    if (outboundLinkCount(page.body, paths, rel) < MIN_OUTBOUND_LINKS) {
      warnings.push({
        code: 'few-wikilinks',
        message: `Page has fewer than ${MIN_OUTBOUND_LINKS} resolvable outbound wikilinks.`,
      });
    }
    if (this.taxonomy.size) {
      for (const tag of page.tags) {
        if (!this.taxonomy.has(tag.toLowerCase().trim())) {
          warnings.push({
            code: 'unknown-tag',
            message: `Tag "${tag}" is not in the SCHEMA.md taxonomy.`,
          });
        }
      }
    }
    return warnings;
  }

  private async buildLintContext(registry?: {
    wikiIds: string[];
    onDiskDirs: string[];
  }): Promise<LintContext> {
    const paths = await this.listContentPaths();
    const pages: LintPage[] = [];
    for (const rel of paths) {
      const raw = await readFileOr(this.abs(rel), '');
      const { data, body } = fm.parse(raw);
      pages.push({
        relPath: rel,
        frontmatter: data,
        body,
        content: raw,
        lineCount: raw.split('\n').length,
      });
    }

    const [index, log] = await Promise.all([
      readFileOr(this.abs(INDEX_FILE), ''),
      readFileOr(this.abs(LOG_FILE), ''),
    ]);

    return {
      pages,
      indexContent: index,
      logEntryCount: nav.countLogEntries(log),
      taxonomy: this.taxonomy,
      rawFiles: await this.loadRawFiles(),
      today: isoToday(),
      registryWikiIds: registry?.wikiIds,
      onDiskWikiDirs: registry?.onDiskDirs,
    };
  }

  private async loadRawFiles(): Promise<LintRawFile[]> {
    const rawDir = this.abs('raw');
    const out: LintRawFile[] = [];
    const stack = [rawDir];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.name.endsWith('.md')) {
          const raw = await readFileOr(full, '');
          const stored = String(fm.parse(raw).data.sha256 ?? '').trim();
          out.push({
            relPath: path.relative(this.basePath, full),
            storedSha: stored || null,
            actualSha: sha256Body(raw),
          });
        }
      }
    }
    return out;
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

async function writeIfAbsent(target: string, content: string): Promise<void> {
  try {
    await fs.access(target);
  } catch {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
}

async function readFileOr(target: string, fallback: string): Promise<string> {
  return (await readFileOrNull(target)) ?? fallback;
}

async function readFileOrNull(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return null;
  }
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/** Insert a link under a `## Related Pages` section, creating one if absent. */
function insertRelatedLink(body: string, link: string): string {
  const bullet = `- ${link}`;
  const lines = body.split('\n');
  const headingIdx = lines.findIndex((l) => /^#{2,3}\s+Related Pages\s*$/i.test(l));
  if (headingIdx === -1) {
    const trimmed = body.replace(/\n+$/, '');
    return `${trimmed}\n\n## Related Pages\n${bullet}\n`;
  }
  let insertAt = headingIdx + 1;
  if (lines[insertAt]?.trim() === '') insertAt++;
  lines.splice(insertAt, 0, bullet);
  return lines.join('\n');
}

// Re-export the slug helper for consumers that derive paths themselves.
export { slugify };
