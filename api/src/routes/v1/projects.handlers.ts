import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { WikiRegistry } from '@tkottke90/llm-wiki';
import type {
  WorkspaceStore,
  NewProjectInput,
  PatchProjectInput,
  Project,
} from '../../services/workspace-store.js';
import type { HandlerFailure, HandlerResult } from './threads.handlers.js';
import {
  isLocationRoot,
  resolveWorkspaceLocation,
  createWorkspaceDirectory,
} from '../../services/workspace-location.js';
import {
  provisionDependencyIsolation,
  provisionGitRepository,
  type ExecFileFn,
} from '../../services/workspace-provision.js';
import { getWikiRegistry } from '../../services/wiki.js';
import { snapshotProjectWiki } from '../../services/wiki-snapshot.js';
import { isWikiDomainArchived } from '../../services/wiki-archive-guard.js';
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
    await provisionGitRepository(
      location,
      { git: !!body.git, remoteUrl: body.remoteUrl as string | undefined },
      execFileFn,
    );
  } catch (err) {
    await rm(location, { recursive: true, force: true });
    return badRequest(
      `Failed to provision git repository: ${err instanceof Error ? err.message : String(err)}`,
    );
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
  body: Record<string, unknown>,
): HandlerResult<Project> {
  const intent = body.intent;
  if (intent !== 'close' && intent !== 'abandon') {
    return badRequest('intent must be "close" or "abandon"');
  }
  const project = store.closeProject(workspaceId, intent);
  if (!project) return conflict(`Project ${workspaceId} is not active`);
  return ok(project);
}

// Step 1 of the close process. Idempotent — a project that already has a
// snapshotPath returns it as-is rather than re-copying, so a page reload or
// the retry-on-error button can safely call this again.
export async function snapshotProjectHandler(
  store: WorkspaceStore,
  workspaceId: string,
  registry?: WikiRegistry,
  execFileFn?: ExecFileFn,
): Promise<HandlerResult<{ snapshotPath: string }>> {
  const workspace = store.getWorkspace(workspaceId);
  const project = store.getProject(workspaceId);
  if (!workspace || !project) return notFound(`Project ${workspaceId} not found`);
  if (project.status !== 'closing') {
    return conflict(`Project ${workspaceId} is not in the closing state`);
  }
  if (project.snapshotPath) return ok({ snapshotPath: project.snapshotPath });
  if (!workspace.wikiId) return serverError('Project has no wiki domain to snapshot');

  const reg = registry ?? (await getWikiRegistry());
  let wikiAbsPath: string;
  try {
    wikiAbsPath = (await reg.load(workspace.wikiId)).basePath;
  } catch (err) {
    return serverError(err instanceof Error ? err.message : String(err));
  }

  try {
    const { snapshotPath } = await snapshotProjectWiki(
      workspace.location,
      wikiAbsPath,
      workspace.git,
      execFileFn,
    );
    store.setSnapshotPath(workspaceId, snapshotPath);
    return ok({ snapshotPath });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : String(err));
  }
}

// Step 4's final action. Runs the selective merge, then — only if every
// selected page landed — transitions the project to its terminal status and
// archives its wiki domain (both the on-disk index.md and the registry
// entry). A partial merge failure leaves status at 'closing' and reports
// which pages need retrying, rather than half-closing the project.
export async function completeCloseProjectHandler(
  store: WorkspaceStore,
  workspaceId: string,
  registry?: WikiRegistry,
): Promise<HandlerResult<{ succeeded: string[]; failed: { filename: string; error: string }[] }>> {
  const workspace = store.getWorkspace(workspaceId);
  const project = store.getProject(workspaceId);
  if (!workspace || !project) return notFound(`Project ${workspaceId} not found`);
  if (project.status !== 'closing') {
    return conflict(`Project ${workspaceId} is not in the closing state`);
  }
  if (!workspace.wikiId) return serverError('Project has no wiki domain');

  const reg = registry ?? (await getWikiRegistry());
  let sourceWiki;
  try {
    sourceWiki = await reg.load(workspace.wikiId);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : String(err));
  }

  const selections = project.closeProgress?.mergeSelections ?? [];
  const succeeded: string[] = [];
  const failed: { filename: string; error: string }[] = [];

  for (const { filename, targetDomainId } of selections) {
    try {
      if (isWikiDomainArchived(targetDomainId, store)) {
        throw new Error(`Target domain "${targetDomainId}" is archived`);
      }
      const targetWiki = await reg.load(targetDomainId);
      const page = await sourceWiki.readPage(filename);
      await targetWiki.commitPage({
        type: page.frontmatter.type,
        title: page.frontmatter.title,
        tags: page.frontmatter.tags,
        sources: page.frontmatter.sources,
        body: page.content,
        confidence: page.frontmatter.confidence,
        contested: page.frontmatter.contested,
        contradictions: page.frontmatter.contradictions,
      });
      succeeded.push(filename);
    } catch (err) {
      failed.push({ filename, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (failed.length > 0) {
    return ok({ succeeded, failed });
  }

  const terminalStatus = project.closeIntent === 'abandon' ? 'abandoned' : 'closed';
  store.completeClose(workspaceId, terminalStatus);
  await sourceWiki.archive();
  await reg.archive(workspace.wikiId);

  return ok({ succeeded, failed: [] });
}
