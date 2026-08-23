import type {
  WorkspaceStore,
  NewProjectInput,
  PatchProjectInput,
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

export function listProjectsHandler(store: WorkspaceStore) {
  return ok(store.listProjects());
}

export function getProjectHandler(store: WorkspaceStore, workspaceId: string) {
  const workspace = store.getWorkspace(workspaceId);
  if (!workspace) return notFound(`Workspace ${workspaceId} not found`);
  const project = store.getProject(workspaceId);
  if (!project) return notFound(`Project for workspace ${workspaceId} not found`);
  return ok({ ...workspace, project });
}

export async function createProjectHandler(
  store: WorkspaceStore,
  body: Record<string, unknown>,
): Promise<
  HandlerResult<{
    workspace: NonNullable<ReturnType<WorkspaceStore['getWorkspace']>>;
    project: NonNullable<ReturnType<WorkspaceStore['getProject']>>;
  }>
> {
  if (!body.name || typeof body.name !== 'string') return badRequest('name is required');
  if (!isLocationRoot(body.locationRoot)) {
    return badRequest('locationRoot must be "projects" or "temporary"');
  }
  if (!body.directoryName || typeof body.directoryName !== 'string') {
    return badRequest('directoryName is required');
  }
  if (!body.winCondition || typeof body.winCondition !== 'string')
    return badRequest('winCondition is required');

  let location: string;
  try {
    location = resolveWorkspaceLocation(body.locationRoot, body.directoryName);
    await createWorkspaceDirectory(location);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
  }

  // store.createProject() reads only the specific fields it needs off
  // NewProjectInput — the leftover locationRoot/directoryName keys are
  // harmless to pass through alongside the resolved `location`.
  const result = store.createProject({ ...body, location } as NewProjectInput);
  return ok(
    result as {
      workspace: NonNullable<ReturnType<WorkspaceStore['getWorkspace']>>;
      project: NonNullable<ReturnType<WorkspaceStore['getProject']>>;
    },
  );
}

export function patchProjectHandler(
  store: WorkspaceStore,
  workspaceId: string,
  patch: PatchProjectInput,
) {
  const workspace = store.getWorkspace(workspaceId);
  if (!workspace) return notFound(`Workspace ${workspaceId} not found`);
  const project = store.patchProject(workspaceId, patch);
  if (!project) return notFound(`Project for workspace ${workspaceId} not found`);
  return ok({ ...workspace, project });
}

export function closeProjectHandler(
  store: WorkspaceStore,
  workspaceId: string,
): HandlerResult<NonNullable<ReturnType<WorkspaceStore['getProject']>>> {
  const project = store.closeProject(workspaceId);
  if (!project) return notFound(`Project ${workspaceId} not found or already closed`);
  return ok(project);
}
