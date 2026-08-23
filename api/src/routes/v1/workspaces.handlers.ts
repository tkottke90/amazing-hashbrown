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

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function notFound(error: string): HandlerFailure {
  return { ok: false, status: 404, error };
}

function badRequest(error: string): HandlerFailure {
  return { ok: false, status: 400, error };
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
): Promise<HandlerResult<ReturnType<WorkspaceStore['getWorkspace']>>> {
  if (!body.name || typeof body.name !== 'string') return badRequest('name is required');
  if (!isLocationRoot(body.locationRoot)) {
    return badRequest('locationRoot must be "projects" or "temporary"');
  }
  if (!body.directoryName || typeof body.directoryName !== 'string') {
    return badRequest('directoryName is required');
  }

  let location: string;
  try {
    location = resolveWorkspaceLocation(body.locationRoot, body.directoryName);
    await createWorkspaceDirectory(location);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
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
  const ws = store.patchWorkspace(id, patch);
  if (!ws) return notFound(`Workspace ${id} not found`);
  return ok(ws);
}

export function deleteWorkspaceHandler(
  store: WorkspaceStore,
  id: string,
): HandlerResult<{ deleted: true }> {
  const deleted = store.deleteWorkspace(id);
  if (!deleted) return notFound(`Workspace ${id} not found`);
  return ok({ deleted: true });
}
