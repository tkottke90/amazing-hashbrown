import type { WorkspaceStore, NewWorkspaceInput, PatchWorkspaceInput } from '../../services/workspace-store.js';
import type { HandlerFailure, HandlerResult } from './threads.handlers.js';

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

export function getWorkspaceHandler(store: WorkspaceStore, id: string): HandlerResult<ReturnType<WorkspaceStore['getWorkspace']>> {
  const ws = store.getWorkspace(id);
  if (!ws) return notFound(`Workspace ${id} not found`);
  return ok(ws);
}

export function createWorkspaceHandler(
  store: WorkspaceStore,
  body: Partial<NewWorkspaceInput>,
): HandlerResult<ReturnType<WorkspaceStore['getWorkspace']>> {
  if (!body.name || typeof body.name !== 'string') return badRequest('name is required');
  if (!body.location || typeof body.location !== 'string') return badRequest('location is required');
  const ws = store.createWorkspace(body as NewWorkspaceInput);
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
