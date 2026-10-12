import path from 'node:path';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
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
  isValidLeafName,
  resolveTargetDir,
  createDirectoryEntry,
  createFileEntry,
  hashContent,
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

interface ConflictFailure extends HandlerFailure {
  status: 409;
  conflicts: string[];
}

function conflict(error: string, conflicts: string[]): ConflictFailure {
  return { ok: false, status: 409, error, conflicts };
}

// Distinct from conflict() above, which is reserved for upload/create
// name-collisions and always carries a conflicts: string[] list — a
// hash-mismatch save conflict has no such list, just the current on-disk
// hash the client can act on (e.g. show the user what changed).
interface HashConflictFailure extends HandlerFailure {
  status: 409;
  currentHash: string;
}

function hashConflict(error: string, currentHash: string): HashConflictFailure {
  return { ok: false, status: 409, error, currentHash };
}

function isEnoent(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT';
}

function isEexist(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST';
}

// Shared by uploadFilesHandler/createDirectoryHandler/createFileHandler:
// resolves `dir` under the workspace, mapping a missing directory to 404 and
// a dir that resolves to a file (or any other resolution error, e.g. path
// traversal) to 400.
async function resolveDirOrFail(
  workspaceLocation: string,
  dir: string,
): Promise<{ ok: true; absDir: string } | { ok: false; failure: HandlerFailure }> {
  try {
    const absDir = await resolveTargetDir(workspaceLocation, dir);
    return { ok: true, absDir };
  } catch (err) {
    if (isEnoent(err)) return { ok: false, failure: notFound(`Directory "${dir}" not found`) };
    return {
      ok: false,
      failure: badRequest(err instanceof Error ? err.message : String(err)),
    };
  }
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
  | { kind: 'text'; content: string; contentHash: string }
  | { kind: 'binary'; buffer: Buffer; contentType: string; contentHash: string };

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
    return ok({
      kind: 'binary',
      buffer,
      contentType: getContentType(fileName),
      contentHash: hashContent(buffer),
    });
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

  return ok({ kind: 'text', content: guarded.content, contentHash: guarded.contentHash });
}

export async function patchFileContentHandler(
  store: WorkspaceStore,
  workspaceId: string,
  relativePath: string,
  body: Record<string, unknown>,
): Promise<HandlerResult<{ ok: true; contentHash: string }>> {
  const workspace = store.getWorkspace(workspaceId);
  if (!workspace) return notFound(`Workspace ${workspaceId} not found`);

  if (typeof body.content !== 'string') {
    return badRequest('content is required and must be a string');
  }
  const content = body.content;

  if (typeof body.baseHash !== 'string') {
    return badRequest('baseHash is required and must be a string');
  }
  const baseHash = body.baseHash;
  const force = body.force === true;

  let absPath: string;
  try {
    absPath = resolveFilePathUnderWorkspace(workspace.location, relativePath);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
  }

  // Re-read and re-hash whatever is currently on disk before writing, so a
  // save can never silently overwrite a change that happened after the
  // client last loaded this file — see docs/superpowers/specs/2026-10-12-
  // workspace-file-explorer-sync-and-delete-design.md §1.
  let currentHash: string | null;
  try {
    currentHash = hashContent(await readFile(absPath));
  } catch (err) {
    if (!isEnoent(err)) {
      return serverError(
        `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // File deleted on disk since the client last read it. force recreates
    // it via the writeFile below; otherwise this is a conflict the client
    // must explicitly resolve, not a plain write-failure.
    if (!force) return notFound(`File "${relativePath}" not found`);
    currentHash = null;
  }

  if (!force && currentHash !== null && currentHash !== baseHash) {
    return hashConflict(
      `File "${relativePath}" was modified on disk since it was loaded`,
      currentHash,
    );
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
  return ok({ ok: true, contentHash: hashContent(content) });
}

export interface UploadedFile {
  name: string;
  buffer: Buffer;
}

export async function uploadFilesHandler(
  store: WorkspaceStore,
  workspaceId: string,
  dir: string,
  files: UploadedFile[],
): Promise<HandlerResult<{ created: string[] }>> {
  const workspace = store.getWorkspace(workspaceId);
  if (!workspace) return notFound(`Workspace ${workspaceId} not found`);

  const dirResult = await resolveDirOrFail(workspace.location, dir);
  if (!dirResult.ok) return dirResult.failure;
  const { absDir } = dirResult;

  if (files.length === 0) return badRequest('At least one file is required');

  // Validate every filename before writing anything — a single bad name or
  // collision rejects the whole batch, never a partial write.
  const invalidNames = files.filter((f) => !isValidLeafName(f.name)).map((f) => f.name);

  // Only names that already passed isValidLeafName ever reach path.join()
  // below — an invalid name (e.g. "../escape.txt") must never be statted
  // against the filesystem at all, since that would probe a path outside
  // absDir before it's been rejected.
  const validNames = files.filter((f) => isValidLeafName(f.name));

  const seen = new Set<string>();
  const duplicateNames = new Set<string>();
  for (const f of validNames) {
    if (seen.has(f.name)) duplicateNames.add(f.name);
    seen.add(f.name);
  }

  const existingCollisions: string[] = [];
  for (const name of seen) {
    try {
      await stat(path.join(absDir, name));
      existingCollisions.push(name);
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
  }

  const conflicts = [...new Set([...invalidNames, ...duplicateNames, ...existingCollisions])];
  if (conflicts.length > 0) {
    return conflict(
      `Upload rejected — ${conflicts.length} file name(s) are invalid or already exist`,
      conflicts,
    );
  }

  for (const file of files) {
    // Re-wrapped in a fresh Uint8Array — same reasoning as readFileGuarded's
    // TextDecoder call above: a Buffer's underlying ArrayBufferLike can
    // type-check as a SharedArrayBuffer, which writeFile's ArrayBufferView
    // overload rejects under this project's @types/node.
    await writeFile(path.join(absDir, file.name), new Uint8Array(file.buffer));
  }

  invalidateFileTreeCache(workspaceId);
  return ok({ created: files.map((f) => f.name) });
}

function entryPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export async function createDirectoryHandler(
  store: WorkspaceStore,
  workspaceId: string,
  dir: string,
  name: string,
): Promise<HandlerResult<{ path: string }>> {
  const workspace = store.getWorkspace(workspaceId);
  if (!workspace) return notFound(`Workspace ${workspaceId} not found`);

  if (!isValidLeafName(name)) return badRequest(`Invalid name "${name}"`);

  const dirResult = await resolveDirOrFail(workspace.location, dir);
  if (!dirResult.ok) return dirResult.failure;

  try {
    await createDirectoryEntry(dirResult.absDir, name);
  } catch (err) {
    if (isEexist(err)) return conflict(`"${name}" already exists in this folder`, [name]);
    return serverError(
      `Failed to create directory: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  invalidateFileTreeCache(workspaceId);
  return ok({ path: entryPath(dir, name) });
}

// Mirrors skills.handlers.ts's deleteSkillFileHandler: validate the path
// shape, confirm it actually exists (rm's force:true never throws on a
// missing path, so a real existence check is the only way to surface 404
// instead of a silent 200), then remove it. Works uniformly for a single
// file or a directory tree — recursive:true is a no-op for a plain file.
export async function deleteFileEntryHandler(
  store: WorkspaceStore,
  workspaceId: string,
  relativePath: string,
): Promise<HandlerResult<{ deleted: true }>> {
  const workspace = store.getWorkspace(workspaceId);
  if (!workspace) return notFound(`Workspace ${workspaceId} not found`);

  let absPath: string;
  try {
    // resolveFilePathUnderWorkspace already throws on an empty relativePath
    // ("Invalid file path \"\"") — this is what rejects a delete targeting
    // the workspace root itself, with no separate check needed.
    absPath = resolveFilePathUnderWorkspace(workspace.location, relativePath);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
  }

  try {
    await stat(absPath);
  } catch (err) {
    if (isEnoent(err)) return notFound(`"${relativePath}" not found`);
    return serverError(`Failed to check path: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await rm(absPath, { recursive: true, force: true });
  } catch (err) {
    return serverError(
      `Failed to delete "${relativePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  invalidateFileTreeCache(workspaceId);
  return ok({ deleted: true });
}

export async function createFileHandler(
  store: WorkspaceStore,
  workspaceId: string,
  dir: string,
  name: string,
): Promise<HandlerResult<{ path: string }>> {
  const workspace = store.getWorkspace(workspaceId);
  if (!workspace) return notFound(`Workspace ${workspaceId} not found`);

  if (!isValidLeafName(name)) return badRequest(`Invalid name "${name}"`);

  const dirResult = await resolveDirOrFail(workspace.location, dir);
  if (!dirResult.ok) return dirResult.failure;

  try {
    await createFileEntry(dirResult.absDir, name);
  } catch (err) {
    if (isEexist(err)) return conflict(`"${name}" already exists in this folder`, [name]);
    return serverError(
      `Failed to create file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  invalidateFileTreeCache(workspaceId);
  return ok({ path: entryPath(dir, name) });
}
