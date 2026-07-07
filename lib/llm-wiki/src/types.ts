/**
 * Public types for the @tkottke90/llm-wiki mechanical layer.
 *
 * Everything here is JSON-serializable (dates aside, which are surfaced only on
 * read results) so a future inference layer can consume method outputs directly.
 */

/** Minimal logger interface the library can be handed. No-op if omitted. */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** The `type` a wiki page (or special file) can be assigned. */
export type PageType = 'entity' | 'concept' | 'comparison' | 'query' | 'summary' | 'index' | 'log';

/** Frontmatter as parsed/validated from a wiki page. */
export interface PageFrontmatter {
  title: string;
  /** ISO date string (YYYY-MM-DD). */
  created: string;
  /** ISO date string (YYYY-MM-DD). */
  updated: string;
  type: PageType;
  tags: string[];
  /** Relative paths into `raw/`. */
  sources: string[];
  confidence?: 'high' | 'medium' | 'low';
  contested?: boolean;
  /** Page slugs/paths this page contradicts. */
  contradictions?: string[];
  /** Any additional frontmatter keys are preserved on round-trip. */
  [key: string]: unknown;
}

/** A parsed wiki page: frontmatter + body + filesystem metadata + content hash. */
export interface WikiFile {
  /** Path relative to the wiki root directory. */
  filename: string;
  title: string;
  type: PageType;
  frontmatter: PageFrontmatter;
  /** Body markdown only, without the frontmatter block. */
  content: string;
  /** SHA256 of the body content. */
  sha: string;
  created: Date;
  lastModified: Date;
}

/** Input to {@link LlmWiki.commitPage}. */
export interface PageInput {
  type: PageType;
  title: string;
  tags: string[];
  sources: string[];
  /** Body markdown (no frontmatter). */
  body: string;
  confidence?: PageFrontmatter['confidence'];
  contested?: boolean;
  contradictions?: string[];
  /** One-line summary for the index entry. Derived from `title` when omitted. */
  summary?: string;
  /**
   * Explicit path relative to the wiki root. When omitted it is derived from
   * `type` + a slug of `title` (e.g. `entities/my-page.md`).
   */
  relPath?: string;
}

/** A soft, non-blocking issue surfaced by a write method. */
export interface Warning {
  code: 'few-wikilinks' | 'unknown-tag' | 'missing-related' | string;
  message: string;
}

/** Result of a page write (commitPage / addCrossLink). */
export interface CommitResult {
  /** Path relative to the wiki root. */
  path: string;
  created: boolean;
  warnings: Warning[];
}

/** Result of {@link LlmWiki.ingestPrep}. */
export interface IngestPrep {
  sha256: string;
  isNew: boolean;
  drift: boolean;
  existingRaw: string | null;
  storedSha256: string | null;
  existingPages: string[];
  suggestedRawPath: string;
}

/** A single parsed entry from `log.md`. */
export interface LogEntry {
  /** ISO date string. */
  date: string;
  action: string;
  subject: string;
  /** The raw heading line as written. */
  raw: string;
}

/** Result of {@link LlmWiki.orient}. */
export interface OrientResult {
  schema: string;
  index: string;
  recentLog: LogEntry[];
}

/** A wiki entry as stored in `registry.json` (routing notes are top-level). */
export interface WikiEntry {
  id: string;
  /** Path relative to the wiki root, or absolute. */
  path: string;
  domain: string;
  tags: string[];
  status: 'active' | 'archived';
}

/** Shape of `<wikiRoot>/registry.json`. */
export interface RegistryFile {
  version: number;
  wikis: WikiEntry[];
  /** LLM-authored lines: "<triggers> -> <wiki-id>". */
  routingNotes: string[];
}

/** Result of {@link WikiRegistry.resolve}. */
export type ResolveResult =
  | { path: string; id: string; domain: string; score: number }
  | { ambiguous: true; candidates: Array<{ id: string; path: string }> }
  | { noMatch: true; available: string[] };

export type LintCheckId =
  | 'orphans'
  | 'broken_links'
  | 'index'
  | 'frontmatter'
  | 'page_size'
  | 'tag_audit'
  | 'source_drift'
  | 'log_rotation'
  | 'stale'
  | 'quality'
  | 'contradictions'
  | 'registry_sync';

export type LintSeverity = 'error' | 'warn' | 'info';

/** A single finding from the lint engine. */
export interface LintFinding {
  check: LintCheckId;
  severity: LintSeverity;
  /** Page path relative to the wiki root, when the finding is page-scoped. */
  page?: string;
  message: string;
}

/** Structured lint report. `ok` is false when any error-severity finding exists. */
export interface LintReport {
  ok: boolean;
  checks: LintFinding[];
}

/** Node type — extends PageType with 'source' for raw source file nodes. */
export type GraphNodeType = PageType | 'source';

/** A vertex in the wiki graph. */
export interface GraphNode {
  /** pageStem(relPath), e.g. "entities/large-language-model" */
  id: string;
  title: string;
  type: GraphNodeType;
  tags: string[];
  confidence?: 'high' | 'medium' | 'low';
  contested?: boolean;
}

/** A directed edge in the wiki graph. */
export interface GraphEdge {
  source: string;
  target: string;
  type: 'references' | 'contradicts' | 'derived_from';
}

/** Result of {@link LlmWiki.buildGraph}. */
export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type { EmbeddingAdapter } from '@tkottke90/inference-adapter';
/** @deprecated Use EmbeddingAdapter from @tkottke90/inference-adapter instead. */
export type { EmbeddingAdapter as EmbeddingProvider } from '@tkottke90/inference-adapter';

/** A search result with a relevance score. Returned by {@link LlmWiki.semanticSearch}. */
export interface RankedResult {
  path: string;
  score: number;
  title: string;
}

/** Options for {@link LlmWiki.semanticSearch}. */
export interface SemanticSearchOptions {
  /** Maximum number of results to return. Default 10. */
  limit?: number;
  /**
   * Search mode:
   * - `'semantic'`: embedding cosine similarity only (requires a provider)
   * - `'keyword'`: BM25 full-text scoring only (no provider required)
   * - `'hybrid'`: both fused with Reciprocal Rank Fusion — default
   */
  mode?: 'semantic' | 'keyword' | 'hybrid';
}
