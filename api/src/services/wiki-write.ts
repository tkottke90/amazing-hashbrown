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
  | { status: 'duplicate'; existingPath: string; existingTitle: string }
  | { status: 'wiki_unavailable' }
  | { status: 'unknown_wiki'; wikiId: string }
  | { status: 'wiki_forbidden'; wikiId: string; allowedWikiId: string };

export interface CreateWikiPageParams {
  wikiId: string;
  title: string;
  content: string;
  section: PageType; // 'entity' | 'concept' | 'comparison' | 'query' | 'summary'
  tags?: string[];
  sources?: string[];
  summary?: string;
  confidence?: 'high' | 'medium' | 'low';
  contested?: boolean;
  contradictions?: string[];
  dryRun?: boolean;
  // Skip duplicate detection — only use after reading the blocking page and
  // confirming these are genuinely different documents.
  force?: boolean;
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
  // Set only for a workspace-chat session scoped to a project's wiki — see
  // workspace-chat-stream-handler.ts. Left undefined, this is unrestricted,
  // matching today's global-chat/non-project behavior.
  allowedWikiId?: string,
): Promise<CreateWikiPageResult> {
  const {
    wikiId,
    title,
    content,
    section,
    tags = [],
    sources = [],
    summary,
    confidence,
    contested,
    contradictions,
    dryRun,
    force,
  } = params;

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

  if (allowedWikiId !== undefined && wikiId !== allowedWikiId) {
    return { status: 'wiki_forbidden', wikiId, allowedWikiId };
  }

  const prep = await wiki.ingestPrep({ content, title, keywords: tags });
  if (!force && prep.existingPages[0]) {
    const blockingPath = prep.existingPages[0];
    let existingTitle = blockingPath.split('/').pop()?.replace(/\.md$/, '') ?? blockingPath;
    try {
      const blockingPage = await wiki.readPage(blockingPath);
      existingTitle = String(blockingPage.frontmatter.title ?? existingTitle);
    } catch {
      // leave existingTitle as the filename stem
    }
    return { status: 'duplicate', existingPath: blockingPath, existingTitle };
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
    confidence,
    contested,
    contradictions,
    relPath: undefined,
  });

  return { status: 'written', result };
}

export type UpdateWikiPageResult =
  | { status: 'written'; result: WikiWriteResult; deletedSections: string[] }
  | { status: 'dry_run'; path: string; existingBody: string; proposedBody: string }
  | { status: 'not_found' }
  | { status: 'invalid_path' }
  | { status: 'wiki_unavailable' }
  | { status: 'unknown_wiki'; wikiId: string }
  | { status: 'wiki_forbidden'; wikiId: string; allowedWikiId: string };

export interface UpdateWikiPageParams {
  wikiId: string;
  path: string;
  content: string;
  // 'replace' (default): content replaces the entire page body.
  // 'append': content is appended after the existing body. Pass only the new
  // sections — no need to read and repeat the existing page.
  mode?: 'replace' | 'append';
  tags?: string[]; // omitted -> reuse existing page's tags
  sources?: string[]; // omitted -> reuse existing page's sources
  summary?: string;
  confidence?: 'high' | 'medium' | 'low'; // omitted -> reuse existing page's value
  contested?: boolean; // omitted -> reuse existing page's value
  contradictions?: string[]; // omitted -> reuse existing page's value
  dryRun?: boolean;
}

function extractH2Sections(body: string): string[] {
  return body
    .split('\n')
    .filter((line) => /^## /.test(line))
    .map((line) => line.replace(/^## /, '').trim());
}

export async function updateWikiPage(
  params: UpdateWikiPageParams,
  registry?: WikiRegistry,
  // Set only for a workspace-chat session scoped to a project's wiki — see
  // workspace-chat-stream-handler.ts. Left undefined, this is unrestricted,
  // matching today's global-chat/non-project behavior.
  allowedWikiId?: string,
): Promise<UpdateWikiPageResult> {
  const {
    wikiId,
    path: relPath,
    content,
    mode = 'replace',
    tags,
    sources,
    summary,
    confidence,
    contested,
    contradictions,
    dryRun,
  } = params;

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

  if (allowedWikiId !== undefined && wikiId !== allowedWikiId) {
    return { status: 'wiki_forbidden', wikiId, allowedWikiId };
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

  // In append mode, combine bodies here so the rest of the function (carry-
  // forward, dryRun, deletedSections, commitPage) all see the merged body.
  const effectiveContent = mode === 'append' ? `${existing.content}\n\n${content}` : content;

  // Carry forward tags/sources when omitted. commitPage() unions `sources`
  // internally regardless of what's passed, so this is redundant-but-
  // harmless for sources — but tags is a straight overwrite in
  // commitPage(), so this is the only thing preventing an omitted `tags`
  // from silently wiping the page's existing tags. Doing both explicitly
  // keeps the two params symmetric.
  const effectiveTags = tags ?? existing.frontmatter.tags;
  const effectiveSources = sources ?? existing.frontmatter.sources;
  const effectiveConfidence =
    confidence !== undefined
      ? confidence
      : (existing.frontmatter.confidence as 'high' | 'medium' | 'low' | undefined);
  const effectiveContested =
    contested !== undefined ? contested : (existing.frontmatter.contested as boolean | undefined);
  const effectiveContradictions =
    contradictions !== undefined
      ? contradictions
      : (existing.frontmatter.contradictions as string[] | undefined);

  if (dryRun) {
    return {
      status: 'dry_run',
      path: relPath,
      existingBody: existing.content,
      proposedBody: effectiveContent,
    };
  }

  const existingSections = new Set(extractH2Sections(existing.content));
  const newSections = new Set(extractH2Sections(effectiveContent));
  const deletedSections = [...existingSections].filter((s) => !newSections.has(s));

  const result = await wiki.commitPage({
    type: existing.frontmatter.type,
    title: existing.title,
    tags: effectiveTags,
    sources: effectiveSources,
    body: effectiveContent,
    summary,
    confidence: effectiveConfidence,
    contested: effectiveContested,
    contradictions: effectiveContradictions,
    relPath,
  });

  return { status: 'written', result, deletedSections };
}
