import path from 'node:path';
import type { PageType, Warning, WikiRegistry } from '@tkottke90/llm-wiki';
import { getWikiRegistry } from './wiki.js';

export interface WikiWriteResult {
  path: string; // relative to the wiki root
  created: boolean;
  warnings: Warning[];
}

export type CreateWikiPageResult =
  | { status: 'written'; result: WikiWriteResult }
  | { status: 'dry_run'; title: string; wikiId: string; section: PageType }
  | { status: 'duplicate'; existingPath: string }
  | { status: 'wiki_unavailable' }
  | { status: 'unknown_wiki'; wikiId: string };

export interface CreateWikiPageParams {
  wikiId: string;
  title: string;
  content: string;
  section: PageType; // 'entity' | 'concept' | 'comparison' | 'query' | 'summary'
  tags?: string[];
  sources?: string[];
  summary?: string;
  dryRun?: boolean;
}

// Test-only escape hatch on both functions below: an already-constructed
// registry, used in place of getWikiRegistry(). Production callers never
// set this — same pattern as after-agent.ts's `llm?` param on
// runAfterAgentPipeline(). getWikiRegistry() is a lazy, process-wide
// singleton bound to env.wikiRoot with no other way to redirect it to a
// temp test directory.
export async function createWikiPage(
  params: CreateWikiPageParams,
  registry?: WikiRegistry,
): Promise<CreateWikiPageResult> {
  const { wikiId, title, content, section, tags = [], sources = [], summary, dryRun } = params;

  let reg = registry;
  if (!reg) {
    try {
      reg = await getWikiRegistry();
    } catch {
      return { status: 'wiki_unavailable' };
    }
  }

  let wiki;
  try {
    wiki = await reg.load(wikiId);
  } catch {
    return { status: 'unknown_wiki', wikiId };
  }

  const prep = await wiki.ingestPrep({ content, keywords: tags });
  if (prep.existingPages[0]) {
    return { status: 'duplicate', existingPath: prep.existingPages[0] };
  }

  if (dryRun) {
    return { status: 'dry_run', title, wikiId, section };
  }

  const result = await wiki.commitPage({
    type: section,
    title,
    tags,
    sources,
    body: content,
    summary,
    relPath: undefined,
  });

  return { status: 'written', result };
}

export type UpdateWikiPageResult =
  | { status: 'written'; result: WikiWriteResult }
  | { status: 'dry_run'; path: string; existingBody: string; proposedBody: string }
  | { status: 'not_found' }
  | { status: 'invalid_path' }
  | { status: 'wiki_unavailable' }
  | { status: 'unknown_wiki'; wikiId: string };

export interface UpdateWikiPageParams {
  wikiId: string;
  path: string;
  content: string;
  tags?: string[]; // omitted -> reuse existing page's tags
  sources?: string[]; // omitted -> reuse existing page's sources
  summary?: string;
  dryRun?: boolean;
}

export async function updateWikiPage(
  params: UpdateWikiPageParams,
  registry?: WikiRegistry,
): Promise<UpdateWikiPageResult> {
  const { wikiId, path: relPath, content, tags, sources, summary, dryRun } = params;

  let reg = registry;
  if (!reg) {
    try {
      reg = await getWikiRegistry();
    } catch {
      return { status: 'wiki_unavailable' };
    }
  }

  let wiki;
  try {
    wiki = await reg.load(wikiId);
  } catch {
    return { status: 'unknown_wiki', wikiId };
  }

  // Path-escape guard — LlmWiki's own abs() is a bare path.join with no
  // traversal check. This is the first write path that accepts an
  // arbitrary agent-supplied `path`, so the guard lives here. Compares
  // against base + path.sep (not a bare startsWith) so a sibling dir
  // sharing the base as a string prefix (e.g. /tmp/wiki vs /tmp/wiki-evil)
  // can't slip through.
  const base = path.resolve(wiki.basePath);
  const target = path.resolve(wiki.basePath, relPath);
  if (target !== base && !target.startsWith(base + path.sep)) {
    return { status: 'invalid_path' };
  }

  let existing;
  try {
    existing = await wiki.readPage(relPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'not_found' };
    }
    throw err; // unexpected I/O error — not a modeled result variant
  }

  // Carry forward tags/sources when omitted. commitPage() unions `sources`
  // internally regardless of what's passed, so this is redundant-but-
  // harmless for sources — but tags is a straight overwrite in
  // commitPage(), so this is the only thing preventing an omitted `tags`
  // from silently wiping the page's existing tags. Doing both explicitly
  // keeps the two params symmetric.
  const effectiveTags = tags ?? existing.frontmatter.tags;
  const effectiveSources = sources ?? existing.frontmatter.sources;

  if (dryRun) {
    return {
      status: 'dry_run',
      path: relPath,
      existingBody: existing.content,
      proposedBody: content,
    };
  }

  const result = await wiki.commitPage({
    type: existing.frontmatter.type,
    title: existing.frontmatter.title,
    tags: effectiveTags,
    sources: effectiveSources,
    body: content,
    summary,
    relPath,
  });

  return { status: 'written', result };
}
