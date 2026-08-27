import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { WikiRegistry } from '@tkottke90/llm-wiki';
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
import {
  provisionDependencyIsolation,
  type ExecFileFn,
} from '../../services/workspace-provision.js';
import { getWikiRegistry } from '../../services/wiki.js';
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

function serverError(error: string): HandlerFailure {
  return { ok: false, status: 500, error };
}

/** Routing text for the project wiki domain: lowercase, hyphen-separated. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
  registry?: WikiRegistry,
  execFileFn?: ExecFileFn,
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

  // Provision the project's ephemeral wiki domain before the DB insert so a
  // project row never exists without its wiki. The id is generated here (not
  // in the store) because the domain id is derived from it.
  const reg = registry ?? (await getWikiRegistry());
  const id = randomUUID();
  const domainId = `project-${id}`;
  try {
    await reg.create({
      id: domainId,
      name: body.name,
      domain: slugify(body.name),
      metadata: { type: 'ephemeral', status: 'active' },
    });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : String(err));
  }

  // store.createProject() reads only the specific fields it needs off
  // NewProjectInput — the leftover locationRoot/directoryName keys are
  // harmless to pass through alongside the resolved `location`.
  let result;
  try {
    result = store.createProject({ ...body, location, id, wikiId: domainId } as NewProjectInput);
  } catch (err) {
    // Roll back the wiki domain so no orphaned directory is left behind.
    try {
      await reg.destroy(domainId);
    } catch (destroyErr) {
      logger.warn('createProject rollback: failed to destroy wiki domain', {
        domainId,
        err: String(destroyErr),
      });
    }
    return serverError(err instanceof Error ? err.message : String(err));
  }
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
  // Every workspace reached through this handler has a project, so its
  // wiki_id is always locked (see patchWorkspaceHandler for the same rule).
  if (patch.wikiId !== undefined) {
    return badRequest('wiki_id is locked once a project is attached');
  }
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
