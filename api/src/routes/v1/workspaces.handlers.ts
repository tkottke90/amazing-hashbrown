import { rm } from 'node:fs/promises';
import type { WikiRegistry } from '@tkottke90/llm-wiki';
import type {
  WorkspaceStore,
  NewWorkspaceInput,
  PatchWorkspaceInput,
} from '../../services/workspace-store.js';
import type { HandlerFailure, HandlerResult } from './threads.handlers.js';
import {
  isLocationRoot,
  resolveWorkspaceLocation,
  createWorkspaceDirectory,
} from '../../services/workspace-location.js';
import {
  provisionDependencyIsolation,
  type ExecFileFn,
} from '../../services/workspace-provision.js';
import { getWikiRegistry } from '../../services/wiki.js';
import {
  scanDependencyTargets,
  removeDependencyTargets,
  type DependencyScanEntry,
} from '../../services/dependency-cleanup.js';
import { invalidateWorkspaceChatAgent } from '../../agents/chat-agent.js';
import { logger } from '../../config/logger.js';

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function notFound(error: string): HandlerFailure {
  return { ok: false, status: 404, error };
}

function badRequest(error: string): HandlerFailure {
  return { ok: false, status: 400, error };
}

function conflict(error: string): HandlerFailure {
  return { ok: false, status: 409, error };
}

export function listWorkspacesHandler(store: WorkspaceStore) {
  return ok(store.listWorkspaces());
}

export function getWorkspaceHandler(
  store: WorkspaceStore,
  id: string,
): HandlerResult<ReturnType<WorkspaceStore['getWorkspace']>> {
  const ws = store.getWorkspace(id);
  if (!ws) return notFound(`Workspace ${id} not found`);
  return ok(ws);
}

export async function createWorkspaceHandler(
  store: WorkspaceStore,
  body: Record<string, unknown>,
  execFileFn?: ExecFileFn,
): Promise<HandlerResult<ReturnType<WorkspaceStore['getWorkspace']>>> {
  if (!body.name || typeof body.name !== 'string') return badRequest('name is required');
  if (!isLocationRoot(body.locationRoot)) {
    return badRequest('locationRoot must be "projects" or "temporary"');
  }
  if (!body.directoryName || typeof body.directoryName !== 'string') {
    return badRequest('directoryName is required');
  }
  if (store.findWorkspaceByName(body.name)) {
    return conflict(`A workspace named "${body.name}" already exists.`);
  }

  let location: string;
  try {
    location = resolveWorkspaceLocation(body.locationRoot, body.directoryName);
    await createWorkspaceDirectory(location);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
  }

  try {
    await provisionDependencyIsolation(
      location,
      { javascript: !!body.javascript, python: !!body.python },
      execFileFn,
    );
  } catch (err) {
    await rm(location, { recursive: true, force: true });
    return badRequest(
      `Failed to provision dependency isolation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // store.createWorkspace() reads only the specific fields it needs off
  // NewWorkspaceInput — the leftover locationRoot/directoryName keys are
  // harmless to pass through alongside the resolved `location`.
  const ws = store.createWorkspace({ ...body, location } as NewWorkspaceInput);
  return ok(ws);
}

export function patchWorkspaceHandler(
  store: WorkspaceStore,
  id: string,
  patch: PatchWorkspaceInput,
): HandlerResult<ReturnType<WorkspaceStore['getWorkspace']>> {
  // A project's wiki domain is provisioned automatically and lives for the
  // project's lifetime — the pointer to it must not change underneath it.
  if (patch.wikiId !== undefined && store.getProject(id)) {
    return badRequest('wiki_id is locked once a project is attached');
  }
  const ws = store.patchWorkspace(id, patch);
  if (!ws) return notFound(`Workspace ${id} not found`);

  // Any of these change what belongs in the workspace-chat system prompt —
  // drop the cached agent so the next turn rebuilds it with fresh context.
  if (patch.goal !== undefined || patch.systemPrompt !== undefined || patch.wikiId !== undefined) {
    invalidateWorkspaceChatAgent(id);
  }

  return ok(ws);
}

export async function deleteWorkspaceHandler(
  store: WorkspaceStore,
  id: string,
  registry?: WikiRegistry,
): Promise<HandlerResult<{ deleted: true }>> {
  const workspace = store.getWorkspace(id);
  const project = store.getProject(id);
  const deleted = store.deleteWorkspace(id);
  if (!deleted) return notFound(`Workspace ${id} not found`);

  // Project-provisioned wikis die with the workspace. DB rows go first: a
  // failed filesystem delete is recoverable, the reverse is not — so wiki
  // destruction is best-effort and never fails the request. A manually-set
  // wikiId on a project-less workspace is left alone.
  if (project && workspace?.wikiId) {
    try {
      const reg = registry ?? (await getWikiRegistry());
      await reg.destroy(workspace.wikiId);
    } catch (err) {
      logger.warn('deleteWorkspace: failed to destroy project wiki domain', {
        workspaceId: id,
        wikiId: workspace.wikiId,
        err: String(err),
      });
    }
  }
  return ok({ deleted: true });
}

export type CleanupDependenciesResult =
  | { dryRun: true; candidates: DependencyScanEntry[] }
  | { dryRun: false; removed: string[]; bytesFreed: number };

// Step 3 of the project close process. `dryRun: true` only scans and reports
// what's found (used to populate the checklist before the user acts);
// omitted/false actually removes the selected subset. Both branches re-scan
// (rather than trusting the client's relPath list wholesale) so removal is
// always scoped to what scanDependencyTargets() itself would find.
export async function cleanupDependenciesHandler(
  store: WorkspaceStore,
  workspaceId: string,
  body: Record<string, unknown>,
): Promise<HandlerResult<CleanupDependenciesResult>> {
  const workspace = store.getWorkspace(workspaceId);
  if (!workspace) return notFound(`Workspace ${workspaceId} not found`);

  const removeNodeModules = !!body.removeNodeModules;
  const removePythonEnv = !!body.removePythonEnv;
  const dryRun = !!body.dryRun;

  const found = await scanDependencyTargets(workspace.location, {
    javascript: removeNodeModules,
    python: removePythonEnv,
  });

  if (dryRun) {
    return ok({ dryRun: true, candidates: found });
  }

  const { removed, bytesFreed } = await removeDependencyTargets(
    workspace.location,
    found.map((f) => f.path),
  );
  return ok({ dryRun: false, removed, bytesFreed });
}
