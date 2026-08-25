import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ExecFileFn } from './workspace-provision.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileNode {
  name: string;
  path: string; // relative to workspace root, forward-slash separated
  type: 'file' | 'dir';
  children?: FileNode[]; // only on type: 'dir'
  gitStatus?: 'M' | 'A'; // only on type: 'file', only when the workspace has git enabled
}

export interface FileTreeResult {
  branch: string | null;
  entries: FileNode[];
}

export type ReadGuardResult =
  | { ok: true; content: string }
  | { ok: false; reason: 'too-large' | 'binary' };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXCLUDED_DIR_NAMES = new Set(['.git', 'node_modules', '.venv']);
const CACHE_TTL_MS = 15_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SNIFF_BYTES = 8 * 1024;
const GIT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Tree walker
// ---------------------------------------------------------------------------

function compareNodes(a: FileNode, b: FileNode): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

async function walk(dirAbsPath: string, relPrefix: string): Promise<FileNode[]> {
  const dirents = await readdir(dirAbsPath, { withFileTypes: true });
  const nodes: FileNode[] = [];

  for (const dirent of dirents) {
    // Symlinks are skipped outright (not followed) — this is what avoids
    // cycles without needing real cycle detection (e.g. a symlink pointing
    // back up into an ancestor directory).
    if (dirent.isSymbolicLink()) continue;

    const relPath = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;

    if (dirent.isDirectory()) {
      // Excluded at any depth, not just the workspace root.
      if (EXCLUDED_DIR_NAMES.has(dirent.name)) continue;
      const children = await walk(path.join(dirAbsPath, dirent.name), relPath);
      nodes.push({ name: dirent.name, path: relPath, type: 'dir', children });
    } else if (dirent.isFile()) {
      nodes.push({ name: dirent.name, path: relPath, type: 'file' });
    }
  }

  return nodes.sort(compareNodes);
}

// Recursive walk of `root`. Throws (ENOENT/EACCES) when the root itself is
// missing or unreadable — the caller (the route handler) maps that to a
// typed HandlerFailure rather than this service knowing about HTTP.
export async function buildFileTree(root: string): Promise<FileNode[]> {
  return walk(root, '');
}

// ---------------------------------------------------------------------------
// Git status overlay
// ---------------------------------------------------------------------------

// '??' (untracked) and a staged add ('A' in the staged column) both map to
// 'A'. A rename ('R  old -> new') is keyed under the *new* path as 'A' — the
// old path never appears in a filesystem walk anyway. Any 'M' in either the
// staged or unstaged column maps to 'M', and takes priority over a
// simultaneous staged-add (e.g. "AM": staged as added, modified again since)
// since that file has real uncommitted changes worth flagging. No 'D'
// (deleted) status is needed — a deleted file never appears in the walk.
export function parsePorcelain(output: string): Map<string, 'M' | 'A'> {
  const statuses = new Map<string, 'M' | 'A'>();
  const lines = output.split('\n').filter((line) => line.trim().length > 0);

  for (const line of lines) {
    const x = line[0];
    const y = line[1];
    let rest = line.slice(3);

    const isRename = x === 'R' || y === 'R';
    const renameArrow = rest.indexOf(' -> ');
    if (renameArrow !== -1) rest = rest.slice(renameArrow + 4);

    const filePath = rest.trim();
    if (!filePath) continue;

    if (isRename) {
      statuses.set(filePath, 'A');
    } else if (x === 'M' || y === 'M') {
      statuses.set(filePath, 'M');
    } else if ((x === '?' && y === '?') || x === 'A') {
      statuses.set(filePath, 'A');
    }
  }

  return statuses;
}

// Shells out to `git branch --show-current` / `git status --porcelain` in
// `location`, using the same injectable-execFileFn pattern as
// provisionDependencyIsolation (workspace-provision.ts) so tests can stub it
// instead of depending on a real git binary/repo.
export async function getGitOverlay(
  location: string,
  execFileFn: ExecFileFn = execFileAsync,
): Promise<{ branch: string | null; statuses: Map<string, 'M' | 'A'> }> {
  const branchResult = await execFileFn('git', ['branch', '--show-current'], {
    cwd: location,
    timeout: GIT_TIMEOUT_MS,
  });
  const branch = branchResult.stdout.trim() || null;

  const statusResult = await execFileFn('git', ['status', '--porcelain'], {
    cwd: location,
    timeout: GIT_TIMEOUT_MS,
  });
  const statuses = parsePorcelain(statusResult.stdout);

  return { branch, statuses };
}

function applyGitStatuses(nodes: FileNode[], statuses: Map<string, 'M' | 'A'>): void {
  for (const node of nodes) {
    if (node.type === 'file') {
      const status = statuses.get(node.path);
      if (status) node.gitStatus = status;
    } else if (node.children) {
      applyGitStatuses(node.children, statuses);
    }
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  tree: FileTreeResult;
  fetchedAt: number;
}

// Keyed by workspaceId (not location) so invalidation from the PATCH handler
// is a one-line cache.delete(workspaceId).
const cache = new Map<string, CacheEntry>();

// Composed, cached entry point: walks the tree, overlays git status (when
// enabled), and caches the result for CACHE_TTL_MS so repeated tree fetches
// (tab open, tab switch) don't re-walk the filesystem / re-shell-out to git
// every time.
export async function getFileTree(
  workspaceId: string,
  workspace: { location: string; git: boolean },
  execFileFn?: ExecFileFn,
): Promise<FileTreeResult> {
  const cached = cache.get(workspaceId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.tree;
  }

  const entries = await buildFileTree(workspace.location);

  let branch: string | null = null;
  if (workspace.git) {
    const overlay = await getGitOverlay(workspace.location, execFileFn);
    branch = overlay.branch;
    applyGitStatuses(entries, overlay.statuses);
  }

  const tree: FileTreeResult = { branch, entries };
  cache.set(workspaceId, { tree, fetchedAt: Date.now() });
  return tree;
}

export function invalidateFileTreeCache(workspaceId: string): void {
  cache.delete(workspaceId);
}

// ---------------------------------------------------------------------------
// File content guards
// ---------------------------------------------------------------------------

// fs.stat size check first (also the natural place an ENOENT for a
// missing/deleted-on-disk file surfaces to the caller); then a null-byte
// sniff over the first 8KB plus a strict UTF-8 decode attempt — either
// failure reports 'binary'.
export async function readFileGuarded(absPath: string): Promise<ReadGuardResult> {
  const stats = await stat(absPath);
  if (stats.size > MAX_FILE_BYTES) {
    return { ok: false, reason: 'too-large' };
  }

  const buffer = await readFile(absPath);

  const sniffLength = Math.min(buffer.length, SNIFF_BYTES);
  for (let i = 0; i < sniffLength; i++) {
    if (buffer[i] === 0) {
      return { ok: false, reason: 'binary' };
    }
  }

  let content: string;
  try {
    // TextDecoder#decode() wants a plain ArrayBuffer-backed view; a Node
    // Buffer's underlying ArrayBufferLike can type-check as a
    // SharedArrayBuffer, which the DOM lib typings reject. Re-wrapping in a
    // fresh Uint8Array (the array-like constructor overload, not the
    // ArrayBufferLike-view one) sidesteps that without an unsafe cast.
    content = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buffer));
  } catch {
    return { ok: false, reason: 'binary' };
  }

  return { ok: true, content };
}

// Buffer.byteLength (not .length) so multi-byte characters are measured by
// their actual UTF-8 byte size, not their UTF-16 code-unit count.
export function isContentTooLarge(content: string): boolean {
  return Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES;
}
