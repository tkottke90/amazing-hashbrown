// Which wiki domains a conversation may write to (issue #202). One rule,
// shared by the chat agent's wiki write tools and the AfterAgent pipeline:
//
// - A workspace with a bound wiki (project or not) is a *known domain* —
//   every write is locked to it.
// - A workspace without one goes looking, but never into a wiki another
//   workspace owns.
// - Global contexts (chat, wiki ingestion, global tasks) go looking across
//   every domain, as before.
// - Anything we can't place fails closed.
//
// Resolved per write (not captured when an agent is built): an unbound
// workspace's exclusions depend on *other* workspaces' bindings, which can
// change while its cached agent lives on. See
// docs/superpowers/specs/2026-09-28-workspace-dedicated-wiki-design.md.
import { getThreadStore, type ThreadStore } from './thread-store.js';
import { getWorkspaceStore, type Workspace, type WorkspaceStore } from './workspace-store.js';

export type WikiWriteScope =
  | { kind: 'locked'; wikiId: string }
  | { kind: 'open'; excludedWikiIds: string[] }
  | { kind: 'unresolved' };

export type WikiWriteDenial = 'locked' | 'owned-by-another-workspace' | 'unresolved';

export type WikiWriteCheck = { allowed: true } | { allowed: false; reason: WikiWriteDenial };

export interface WikiWriteScopeContext {
  threadId: string;
  // Server-set configurable.workspaceId (workspace chat, task runs, headless
  // turns). Preferred over the thread lookup when present.
  workspaceId?: string;
}

export interface WikiWriteScopeStores {
  workspaceStore?: WorkspaceStore;
  threadStore?: ThreadStore;
}

const UNRESOLVED: WikiWriteScope = { kind: 'unresolved' };
const OPEN: WikiWriteScope = { kind: 'open', excludedWikiIds: [] };

function scopeForWorkspace(workspace: Workspace, store: WorkspaceStore): WikiWriteScope {
  if (workspace.wikiId) return { kind: 'locked', wikiId: workspace.wikiId };
  return { kind: 'open', excludedWikiIds: store.listBoundWikiIds() };
}

export function resolveWikiWriteScope(
  context: WikiWriteScopeContext,
  stores: WikiWriteScopeStores = {},
): WikiWriteScope {
  // Stores are fetched lazily (a global chat thread never needs the
  // workspace store), and any failure to reach one fails closed.
  const workspaces = () => stores.workspaceStore ?? getWorkspaceStore();
  const threads = () => stores.threadStore ?? getThreadStore();
  const forWorkspace = (id: string): WikiWriteScope => {
    const workspace = workspaces().getWorkspace(id);
    return workspace ? scopeForWorkspace(workspace, workspaces()) : UNRESOLVED;
  };

  try {
    if (context.workspaceId) return forWorkspace(context.workspaceId);

    const meta = threads().getThreadMeta(context.threadId);
    if (!meta) return UNRESOLVED;

    switch (meta.type) {
      case 'workspace-chat': {
        const workspace = workspaces().getWorkspaceByThreadId(context.threadId);
        return workspace ? scopeForWorkspace(workspace, workspaces()) : UNRESOLVED;
      }
      case 'task': {
        // Workspace-scoped task runs execute in their own 'task' thread, not
        // the workspace-chat thread — reach the workspace through the task.
        const task = workspaces().getTaskByThreadId(context.threadId);
        if (!task) return UNRESOLVED;
        return task.workspaceId ? forWorkspace(task.workspaceId) : OPEN;
      }
      case 'chat':
      case 'wiki':
        return OPEN;
      default:
        return UNRESOLVED;
    }
  } catch {
    return UNRESOLVED;
  }
}

export function checkWikiWrite(scope: WikiWriteScope, wikiId: string): WikiWriteCheck {
  switch (scope.kind) {
    case 'locked':
      return wikiId === scope.wikiId ? { allowed: true } : { allowed: false, reason: 'locked' };
    case 'open':
      return scope.excludedWikiIds.includes(wikiId)
        ? { allowed: false, reason: 'owned-by-another-workspace' }
        : { allowed: true };
    case 'unresolved':
      return { allowed: false, reason: 'unresolved' };
  }
}
