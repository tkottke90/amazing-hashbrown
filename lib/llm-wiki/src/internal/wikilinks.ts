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
 * Split a normalized link target into a cross-wiki reference, when it has
 * one. Expects `target` to already have alias/`.md` stripped (i.e. the
 * output of {@link normalizeLink}) — the colon split happens on top of that,
 * not before it, so `other-wiki:entities/foo|Label` and
 * `other-wiki:entities/foo.md` both parse the same way.
 *
 * A target with no colon, or an empty wiki id before the colon, is not an
 * external reference (returns `null`) — no real page path contains a colon,
 * and an empty wiki id is degenerate input rather than a real reference.
 */
export function parseExternalRef(target: string): { wikiId: string; pagePath: string } | null {
  const idx = target.indexOf(':');
  if (idx <= 0) return null;
  const wikiId = target.slice(0, idx);
  const pagePath = target.slice(idx + 1);
  if (!pagePath) return null;
  return { wikiId, pagePath };
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
