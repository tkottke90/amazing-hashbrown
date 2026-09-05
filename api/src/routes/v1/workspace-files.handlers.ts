import path from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';
import type { WorkspaceStore } from '../../services/workspace-store.js';
import type { HandlerFailure, HandlerResult } from './threads.handlers.js';
import { resolveFilePathUnderWorkspace } from '../../services/workspace-location.js';
import {
  getFileTree,
  readFileGuarded,
  isContentTooLarge,
  invalidateFileTreeCache,
  classifyFile,
  getContentType,
  type FileTreeResult,
} from '../../services/workspace-files.js';
import type { ExecFileFn } from '../../services/workspace-provision.js';

// threads.handlers.ts only exports the HandlerFailure/HandlerResult *types*,
// not its ok/notFound/serverError/invalid helper functions — so this file
// defines its own, exactly like workspaces.handlers.ts already does.

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function notFound(error: string): HandlerFailure {
  return { ok: false, status: 404, error };
}

function badRequest(error: string): HandlerFailure {
  return { ok: false, status: 400, error };
}

function unprocessable(error: string): HandlerFailure {
  return { ok: false, status: 422, error };
}

function serverError(error: string): HandlerFailure {
  return { ok: false, status: 500, error };
}

function isEnoent(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT';
}

export async function getFileTreeHandler(
  store: WorkspaceStore,
  workspaceId: string,
  execFileFn?: ExecFileFn,
): Promise<HandlerResult<FileTreeResult>> {
  const workspace = store.getWorkspace(workspaceId);
  if (!workspace) return notFound(`Workspace ${workspaceId} not found`);

  try {
    const tree = await getFileTree(
      workspaceId,
      { location: workspace.location, git: workspace.git },
      execFileFn,
    );
    return ok(tree);
  } catch (err) {
    return badRequest(
      `Failed to read workspace directory: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export type FileContentResult =
  | { kind: 'text'; content: string }
  | { kind: 'binary'; buffer: Buffer; contentType: string };

export async function getFileContentHandler(
  store: WorkspaceStore,
  workspaceId: string,
  relativePath: string,
): Promise<HandlerResult<FileContentResult>> {
  const workspace = store.getWorkspace(workspaceId);
  if (!workspace) return notFound(`Workspace ${workspaceId} not found`);

  let absPath: string;
  try {
    absPath = resolveFilePathUnderWorkspace(workspace.location, relativePath);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
  }

  const fileName = path.basename(relativePath);
  const category = classifyFile(fileName);

  if (category === 'unsupported') {
    // Existence check first, so a missing unsupported-extension file still
    // 404s instead of 422ing.
    try {
      await stat(absPath);
    } catch (err) {
      if (isEnoent(err)) return notFound(`File "${relativePath}" not found`);
      return badRequest(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
    }
    return unprocessable(`File "${relativePath}" cannot be previewed`);
  }

  if (category === 'image' || category === 'audio' || category === 'video') {
    // No size cap here — that's a text-editor constraint (loading a whole
    // file into CodeMirror as a JS string), not one that applies to
    // streaming bytes straight to a native <img>/<audio>/<video> element.
    let buffer: Buffer;
    try {
      buffer = await readFile(absPath);
    } catch (err) {
      if (isEnoent(err)) return notFound(`File "${relativePath}" not found`);
      return badRequest(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
    }
    return ok({ kind: 'binary', buffer, contentType: getContentType(fileName) });
  }

  let guarded;
  try {
    guarded = await readFileGuarded(absPath);
  } catch (err) {
    if (isEnoent(err)) return notFound(`File "${relativePath}" not found`);
    return badRequest(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!guarded.ok) {
    return unprocessable(
      guarded.reason === 'too-large'
        ? `File "${relativePath}" is too large to display`
        : `File "${relativePath}" cannot be displayed as text`,
    );
  }

  return ok({ kind: 'text', content: guarded.content });
}

export async function patchFileContentHandler(
  store: WorkspaceStore,
  workspaceId: string,
  relativePath: string,
  body: Record<string, unknown>,
): Promise<HandlerResult<{ ok: true }>> {
  const workspace = store.getWorkspace(workspaceId);
  if (!workspace) return notFound(`Workspace ${workspaceId} not found`);

  if (typeof body.content !== 'string') {
    return badRequest('content is required and must be a string');
  }
  const content = body.content;

  let absPath: string;
  try {
    absPath = resolveFilePathUnderWorkspace(workspace.location, relativePath);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
  }

  if (isContentTooLarge(content)) {
    return unprocessable(`File "${relativePath}" exceeds the maximum allowed size`);
  }

  try {
    await writeFile(absPath, content, 'utf8');
  } catch (err) {
    return serverError(`Failed to write file: ${err instanceof Error ? err.message : String(err)}`);
  }

  invalidateFileTreeCache(workspaceId);
  return ok({ ok: true });
}
