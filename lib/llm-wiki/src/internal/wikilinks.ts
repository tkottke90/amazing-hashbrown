/** `[[wikilink]]` extraction, normalization, and resolution. Pure. */

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/** Extract raw wikilink targets (inner text) from markdown. */
export function extractWikilinks(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(WIKILINK_RE)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/** Strip an `|alias` and a trailing `.md` from a wikilink target. */
export function normalizeLink(linkText: string): string {
  const noAlias = linkText.split('|')[0] ?? linkText;
  return noAlias.trim().replace(/\.md$/i, '');
}

/** The basename of a page path without its `.md` suffix. */
export function pageBasename(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath;
  return base.replace(/\.md$/i, '');
}

/** A page path without its `.md` suffix (keeps the subdirectory). */
export function pageStem(relPath: string): string {
  return relPath.replace(/\.md$/i, '');
}

/**
 * Resolve a normalized link target against a set of page paths, trying a full
 * stem match (`entities/foo`) first, then a basename match (`foo`).
 * Returns the matching page path, or null.
 */
export function resolveLinkTarget(target: string, pages: readonly string[]): string | null {
  const norm = normalizeLink(target);
  const byStem = new Map(pages.map((p) => [pageStem(p), p] as const));
  const byBase = new Map(pages.map((p) => [pageBasename(p), p] as const));
  return byStem.get(norm) ?? byBase.get(norm) ?? null;
}

/** Count distinct, resolvable outbound wikilinks from a page's content. */
export function outboundLinkCount(content: string, pages: readonly string[], self: string): number {
  const targets = new Set<string>();
  for (const link of extractWikilinks(content)) {
    const resolved = resolveLinkTarget(link, pages);
    if (resolved && resolved !== self) targets.add(resolved);
  }
  return targets.size;
}
