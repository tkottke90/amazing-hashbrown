import type { WorkspaceStore, Workspace } from '../../services/workspace-store.js';
import type { HandlerFailure, HandlerResult } from './threads.handlers.js';
import {
  getGitStatus,
  listBranches,
  fetchRemote,
  syncFastForward,
  pushBranch,
  checkoutBranch,
  createBranch,
  withLock,
  GitOperationInProgressError,
  type GitStatus,
  type GitBranches,
} from '../../services/workspace-git.js';
import { invalidateFileTreeCache } from '../../services/workspace-files.js';
import type { ExecFileFn } from '../../services/workspace-provision.js';

// threads.handlers.ts only exports the HandlerFailure/HandlerResult *types*,
// not its ok/notFound/badRequest/conflict helpers — so this file defines its
// own, matching workspace-files.handlers.ts's/workspaces.handlers.ts's
// per-file duplication convention.

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

type GitWorkspaceCheck =
  { ok: true; workspace: Workspace } | { ok: false; failure: HandlerFailure };

function requireGitWorkspace(store: WorkspaceStore, workspaceId: string): GitWorkspaceCheck {
  const workspace = store.getWorkspace(workspaceId);
  if (!workspace) return { ok: false, failure: notFound(`Workspace ${workspaceId} not found`) };
  if (!workspace.git) {
    return { ok: false, failure: badRequest('Workspace does not have git enabled') };
  }
  return { ok: true, workspace };
}

// Shared tail for every mutating endpoint: run `op` under the per-workspace
// lock, invalidate the file-tree cache on success (so the Files tab picks up
// the new branch/status), then return fresh status as the response body —
// so the client never needs a second round trip after a mutation.
async function runMutation(
  workspaceId: string,
  location: string,
  op: () => Promise<void>,
  execFileFn?: ExecFileFn,
): Promise<HandlerResult<GitStatus>> {
  try {
    await withLock(workspaceId, op);
  } catch (err) {
    if (err instanceof GitOperationInProgressError) return conflict(err.message);
    return badRequest(err instanceof Error ? err.message : String(err));
  }

  invalidateFileTreeCache(workspaceId);

  try {
    const status = await getGitStatus(location, execFileFn);
    return ok(status);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
  }
}

export async function getGitStatusHandler(
  store: WorkspaceStore,
  workspaceId: string,
  execFileFn?: ExecFileFn,
): Promise<HandlerResult<GitStatus>> {
  const check = requireGitWorkspace(store, workspaceId);
  if (!check.ok) return check.failure;

  try {
    return ok(await getGitStatus(check.workspace.location, execFileFn));
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
  }
}

export async function listBranchesHandler(
  store: WorkspaceStore,
  workspaceId: string,
  execFileFn?: ExecFileFn,
): Promise<HandlerResult<GitBranches>> {
  const check = requireGitWorkspace(store, workspaceId);
  if (!check.ok) return check.failure;

  try {
    return ok(await listBranches(check.workspace.location, execFileFn));
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
  }
}

export async function fetchHandler(
  store: WorkspaceStore,
  workspaceId: string,
  execFileFn?: ExecFileFn,
): Promise<HandlerResult<GitStatus>> {
  const check = requireGitWorkspace(store, workspaceId);
  if (!check.ok) return check.failure;

  return runMutation(
    workspaceId,
    check.workspace.location,
    () => fetchRemote(check.workspace.location, execFileFn),
    execFileFn,
  );
}

export async function syncHandler(
  store: WorkspaceStore,
  workspaceId: string,
  execFileFn?: ExecFileFn,
): Promise<HandlerResult<GitStatus>> {
  const check = requireGitWorkspace(store, workspaceId);
  if (!check.ok) return check.failure;

  return runMutation(
    workspaceId,
    check.workspace.location,
    () => syncFastForward(check.workspace.location, execFileFn),
    execFileFn,
  );
}

export async function pushHandler(
  store: WorkspaceStore,
  workspaceId: string,
  execFileFn?: ExecFileFn,
): Promise<HandlerResult<GitStatus>> {
  const check = requireGitWorkspace(store, workspaceId);
  if (!check.ok) return check.failure;

  return runMutation(
    workspaceId,
    check.workspace.location,
    () => pushBranch(check.workspace.location, execFileFn),
    execFileFn,
  );
}

export async function checkoutHandler(
  store: WorkspaceStore,
  workspaceId: string,
  body: Record<string, unknown>,
  execFileFn?: ExecFileFn,
): Promise<HandlerResult<GitStatus>> {
  const check = requireGitWorkspace(store, workspaceId);
  if (!check.ok) return check.failure;
  if (!body.branch || typeof body.branch !== 'string') return badRequest('branch is required');

  return runMutation(
    workspaceId,
    check.workspace.location,
    () => checkoutBranch(check.workspace.location, body.branch as string, execFileFn),
    execFileFn,
  );
}

export async function createBranchHandler(
  store: WorkspaceStore,
  workspaceId: string,
  body: Record<string, unknown>,
  execFileFn?: ExecFileFn,
): Promise<HandlerResult<GitStatus>> {
  const check = requireGitWorkspace(store, workspaceId);
  if (!check.ok) return check.failure;
  if (!body.name || typeof body.name !== 'string') return badRequest('name is required');
  if (body.from !== undefined && typeof body.from !== 'string') {
    return badRequest('from must be a string');
  }
  const from = body.from as string | undefined;

  return runMutation(
    workspaceId,
    check.workspace.location,
    () => createBranch(check.workspace.location, body.name as string, from, execFileFn),
    execFileFn,
  );
}
