/** Path, slug, and directory-layout helpers. Pure — no filesystem access. */

import type { PageType } from '../types.js';

/** Wiki page subdirectories that hold linkable content pages. */
export const WIKI_SUBDIRS = ['entities', 'concepts', 'comparisons', 'queries'] as const;

/** All directories created when a wiki is scaffolded. */
export const WIKI_DIRS = ['raw', ...WIKI_SUBDIRS] as const;

/** Special files at the wiki root. */
export const SCHEMA_FILE = 'SCHEMA.md';
export const INDEX_FILE = 'index.md';
export const LOG_FILE = 'log.md';

/** Map a content page type to its subdirectory. */
const TYPE_DIR: Record<PageType, string> = {
  entity: 'entities',
  concept: 'concepts',
  comparison: 'comparisons',
  query: 'queries',
  summary: 'concepts',
  index: '',
  log: '',
};

/** Lowercase, hyphenate, strip non-alphanumerics; used for filenames. */
export function slugify(input: string, maxLength = 60): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

/** Derive a wiki page path (relative to the wiki root) from a type + title. */
export function pagePathFor(type: PageType, title: string): string {
  const dir = TYPE_DIR[type];
  const slug = slugify(title) || 'untitled';
  return dir ? `${dir}/${slug}.md` : `${slug}.md`;
}

/**
 * Suggest a `raw/` path for a source, matching the skill's naming:
 *   - from a filename: `raw/articles/<slug>.md`
 *   - from a URL:      `raw/articles/<slug>-<date>.md`
 *   - fallback:        `raw/articles/source-<date>.md`
 */
export function suggestRawPath(opts: { url?: string; filename?: string; today: string }): string {
  const { url, filename, today } = opts;
  if (filename) {
    const base = filename.split('/').pop() ?? filename;
    const stem = slugify(base.replace(/\.md$/i, ''));
    return `raw/articles/${stem || 'source'}.md`;
  }
  if (url) {
    const stripped = url.replace(/^https?:\/\/(www\.)?/i, '');
    const slug = slugify(stripped, 50);
    return `raw/articles/${slug || 'source'}-${today}.md`;
  }
  return `raw/articles/source-${today}.md`;
}

/** Today's date as an ISO `YYYY-MM-DD` string. */
export function isoToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
