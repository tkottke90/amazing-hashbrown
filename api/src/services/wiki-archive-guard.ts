// R11 — API-layer half of the archived-wiki-domain write guard. Independent
// of lib/llm-wiki's own index.md-frontmatter check (LlmWiki.writeFileRel's
// assertNotArchived): this one queries projects.status via the owning
// workspace, so it fails closed even if the on-disk frontmatter were ever
// out of sync. Either check alone is sufficient to reject a write; both run.
import type { WorkspaceStore } from './workspace-store.js';

/** True when `wikiId` belongs to a project that has finished closing. A
 * domain with no owning project (e.g. the built-in "user"/"self" wikis, or
 * a manually registered one) never matches and is always writable here. */
export function isWikiDomainArchived(wikiId: string, store: WorkspaceStore): boolean {
  const project = store.getProjectByWikiId(wikiId);
  return project?.status === 'closed' || project?.status === 'abandoned';
}

export function wikiArchivedMessage(wikiId: string): string {
  return `Wiki "${wikiId}" is archived — its project has been closed and it can no longer be written to.`;
}
