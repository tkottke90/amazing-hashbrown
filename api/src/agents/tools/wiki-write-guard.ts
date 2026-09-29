import type { WikiForbiddenResult } from '../../services/wiki-write.js';
import {
  resolveWikiWriteScope,
  type WikiWriteScope,
  type WikiWriteScopeStores,
} from '../../services/wiki-write-scope.js';

// Resolved on every call from the run's own config (never captured when the
// tool is built) — see services/wiki-write-scope.ts for why. No thread_id
// means no conversation to scope to: only evals and unit tests invoke the
// write tools that way, and they stay unrestricted.
export function resolveToolWriteScope(
  config: { configurable?: Record<string, unknown> } | undefined,
  stores?: WikiWriteScopeStores,
): WikiWriteScope | undefined {
  const threadId = config?.configurable?.thread_id;
  if (typeof threadId !== 'string' || !threadId) return undefined;
  const workspaceId = config?.configurable?.workspaceId;
  return resolveWikiWriteScope(
    { threadId, workspaceId: typeof workspaceId === 'string' ? workspaceId : undefined },
    stores,
  );
}

export function wikiWriteForbiddenMessage(wikiId: string, allowedWikiId: string): string {
  return (
    `This workspace is restricted to writing wiki "${allowedWikiId}" — ` +
    `"${wikiId}" is not allowed here — use wiki "${allowedWikiId}" instead.`
  );
}

// Agent-facing text for every wiki_forbidden reason (see
// services/wiki-write-scope.ts). Each one says what to do next, so the agent
// recovers instead of retrying the same rejected write.
export function wikiWriteDeniedMessage(result: WikiForbiddenResult): string {
  switch (result.reason) {
    case 'locked':
      return wikiWriteForbiddenMessage(result.wikiId, result.allowedWikiId ?? '');
    case 'owned-by-another-workspace':
      return (
        `Wiki "${result.wikiId}" belongs to another workspace and can't be written from here. ` +
        `Choose a different wiki (wiki_locate can help), or ask the user where this should go.`
      );
    case 'unresolved':
      return "Wiki writes are unavailable because this conversation's workspace could not be determined.";
  }
}
