/**
 * Individual lint checks. Each is a pure function of a preloaded LintContext,
 * returning findings. No filesystem access here — the context is built once by
 * the caller and shared across all checks.
 */

import type { LintFinding } from '../../types.js';
import { extractWikilinks, resolveLinkTarget, pageStem, pageBasename } from '../wikilinks.js';
import { missingRequired } from '../frontmatter.js';

/** A content page, preloaded for linting. */
export interface LintPage {
  /** Path relative to the wiki root (e.g. `entities/foo.md`). */
  relPath: string;
  frontmatter: Record<string, unknown>;
  body: string;
  /** Full file content (frontmatter + body), used for wikilink scanning. */
  content: string;
  lineCount: number;
}

/** A `raw/` source file, preloaded for drift detection. */
export interface LintRawFile {
  relPath: string;
  storedSha: string | null;
  actualSha: string;
}

/** Everything the checks need, loaded once. */
export interface LintContext {
  pages: LintPage[];
  indexContent: string;
  logEntryCount: number;
  taxonomy: Set<string>;
  rawFiles: LintRawFile[];
  /** ISO `YYYY-MM-DD`; anchors the staleness window. */
  today: string;
  /** Registry wiki ids — present only when linting through WikiRegistry. */
  registryWikiIds?: string[];
  /** Wiki directory names found on disk under the wiki root. */
  onDiskWikiDirs?: string[];
}

const LOG_ROTATION_LIMIT = 500;
const PAGE_SIZE_LIMIT = 200;
// Pages past this character count trigger the read-threshold truncation in
// wiki_read_page. A wiki entry that long is a structure problem, not a
// retrieval one — the warn nudges authors to split before the truncation
// becomes the first symptom anyone notices.
const READ_THRESHOLD_CHARS = 8000;
const STALE_DAYS = 90;

function pagePaths(ctx: LintContext): string[] {
  return ctx.pages.map((p) => p.relPath);
}

export function checkOrphans(ctx: LintContext): LintFinding[] {
  const paths = pagePaths(ctx);
  const inbound = new Map<string, Set<string>>(paths.map((p) => [p, new Set()]));
  for (const page of ctx.pages) {
    for (const link of extractWikilinks(page.content)) {
      const target = resolveLinkTarget(link, paths);
      if (target && target !== page.relPath) inbound.get(target)!.add(page.relPath);
    }
  }
  return ctx.pages
    .filter((p) => inbound.get(p.relPath)!.size === 0)
    .map((p) => ({
      check: 'orphans' as const,
      severity: 'warn' as const,
      page: p.relPath,
      message: 'No inbound wikilinks from any other page.',
    }));
}

export function checkBrokenLinks(ctx: LintContext): LintFinding[] {
  const paths = pagePaths(ctx);
  const findings: LintFinding[] = [];
  for (const page of ctx.pages) {
    for (const link of extractWikilinks(page.content)) {
      if (!resolveLinkTarget(link, paths)) {
        findings.push({
          check: 'broken_links',
          severity: 'error',
          page: page.relPath,
          message: `Wikilink [[${link}]] points to a page that does not exist.`,
        });
      }
    }
  }
  return findings;
}

export function checkIndex(ctx: LintContext): LintFinding[] {
  const index = ctx.indexContent;
  return ctx.pages
    .filter((p) => !index.includes(pageStem(p.relPath)) && !index.includes(pageBasename(p.relPath)))
    .map((p) => ({
      check: 'index' as const,
      severity: 'warn' as const,
      page: p.relPath,
      message: 'Page is not listed in index.md.',
    }));
}

export function checkFrontmatter(ctx: LintContext): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const page of ctx.pages) {
    const missing = missingRequired(page.frontmatter);
    if (missing.length) {
      findings.push({
        check: 'frontmatter',
        severity: 'error',
        page: page.relPath,
        message: `Missing or malformed required frontmatter: ${missing.join(', ')}.`,
      });
    }
  }
  return findings;
}

export function checkPageSize(ctx: LintContext): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const p of ctx.pages) {
    if (p.lineCount > PAGE_SIZE_LIMIT) {
      findings.push({
        check: 'page_size' as const,
        severity: 'info' as const,
        page: p.relPath,
        message: `Page is ${p.lineCount} lines (> ${PAGE_SIZE_LIMIT}); consider splitting.`,
      });
    }
    if (p.content.length > READ_THRESHOLD_CHARS) {
      findings.push({
        check: 'page_size' as const,
        severity: 'warn' as const,
        page: p.relPath,
        message: `Page is ${p.content.length.toLocaleString()} characters (> ${READ_THRESHOLD_CHARS.toLocaleString()}); it will be truncated when read by the agent. Split into focused sub-pages.`,
      });
    }
  }
  return findings;
}

export function checkTagAudit(ctx: LintContext): LintFinding[] {
  if (ctx.taxonomy.size === 0) return [];
  const findings: LintFinding[] = [];
  for (const page of ctx.pages) {
    const tags = Array.isArray(page.frontmatter.tags) ? page.frontmatter.tags : [];
    for (const tag of tags) {
      const t = String(tag).toLowerCase().trim();
      if (t && !ctx.taxonomy.has(t)) {
        findings.push({
          check: 'tag_audit',
          severity: 'warn',
          page: page.relPath,
          message: `Tag "${tag}" is not in the SCHEMA.md taxonomy.`,
        });
      }
    }
  }
  return findings;
}

export function checkSourceDrift(ctx: LintContext): LintFinding[] {
  return ctx.rawFiles
    .filter((r) => r.storedSha !== null && r.storedSha !== r.actualSha)
    .map((r) => ({
      check: 'source_drift' as const,
      severity: 'warn' as const,
      page: r.relPath,
      message: 'Stored sha256 does not match file contents (raw/ was modified).',
    }));
}

export function checkLogRotation(ctx: LintContext): LintFinding[] {
  if (ctx.logEntryCount <= LOG_ROTATION_LIMIT) return [];
  return [
    {
      check: 'log_rotation',
      severity: 'info',
      message: `log.md has ${ctx.logEntryCount} entries (> ${LOG_ROTATION_LIMIT}); rotate to log-YYYY.md.`,
    },
  ];
}

function daysBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.floor((to - from) / 86_400_000);
}

export function checkStale(ctx: LintContext): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const page of ctx.pages) {
    const updated = page.frontmatter.updated;
    if (typeof updated !== 'string') continue;
    const age = daysBetween(updated, ctx.today);
    if (age !== null && age > STALE_DAYS) {
      findings.push({
        check: 'stale',
        severity: 'info',
        page: page.relPath,
        message: `Not updated in ${age} days (> ${STALE_DAYS}).`,
      });
    }
  }
  return findings;
}

export function checkQuality(ctx: LintContext): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const page of ctx.pages) {
    if (page.frontmatter.confidence === 'low') {
      findings.push({
        check: 'quality',
        severity: 'info',
        page: page.relPath,
        message: 'Page has low confidence.',
      });
    }
    if (page.frontmatter.contested === true) {
      findings.push({
        check: 'quality',
        severity: 'warn',
        page: page.relPath,
        message: 'Page is marked contested.',
      });
    }
  }
  return findings;
}

export function checkContradictions(ctx: LintContext): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const page of ctx.pages) {
    const c = page.frontmatter.contradictions;
    if (Array.isArray(c) && c.length > 0) {
      findings.push({
        check: 'contradictions',
        severity: 'warn',
        page: page.relPath,
        message: `Declares contradictions with: ${c.map(String).join(', ')}.`,
      });
    }
  }
  return findings;
}

export function checkRegistrySync(ctx: LintContext): LintFinding[] {
  if (!ctx.registryWikiIds || !ctx.onDiskWikiDirs) return [];
  const registered = new Set(ctx.registryWikiIds);
  return ctx.onDiskWikiDirs
    .filter((dir) => !registered.has(dir))
    .map((dir) => ({
      check: 'registry_sync' as const,
      severity: 'warn' as const,
      message: `Wiki directory "${dir}" is on disk but missing from the registry.`,
    }));
}
