import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';

export type LocationRoot = 'projects' | 'temporary';

const VALID_ROOTS: LocationRoot[] = ['projects', 'temporary'];

export function isLocationRoot(value: unknown): value is LocationRoot {
  return typeof value === 'string' && (VALID_ROOTS as string[]).includes(value);
}

function rootPath(root: LocationRoot): string {
  return root === 'projects' ? env.projectsRoot : env.tempProjectsRoot;
}

// The client already slugifies the directory name, but the field is
// user-editable — this is the actual safety boundary: whatever the user
// types, the resolved path must land as a direct child of `basePath`, never
// escape it via "..", an embedded separator, or an absolute path. Takes the
// base path directly (rather than reading env itself) so it's a pure,
// easily unit-testable function independent of config/env wiring.
export function resolvePathUnderRoot(basePath: string, directoryName: string): string {
  const name = directoryName.trim();
  if (!name) throw new Error('directoryName is required');
  if (
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new Error(`Invalid directoryName "${directoryName}"`);
  }

  const resolved = path.resolve(basePath, name);
  if (path.dirname(resolved) !== basePath) {
    throw new Error(`Invalid directoryName "${directoryName}"`);
  }
  return resolved;
}

export function resolveWorkspaceLocation(root: LocationRoot, directoryName: string): string {
  return resolvePathUnderRoot(rootPath(root), directoryName);
}

// resolvePathUnderRoot() above only validates a single direct-child segment
// (it rejects any embedded "/"), so it can't express a nested relative path
// like "scripts/checksum-verify.py" — this sibling function allows nesting
// while still enforcing the same containment guarantee: the resolved path
// must land at or strictly inside workspaceLocation, never escape it via
// "..", an embedded absolute path, or a null byte.
export function resolveFilePathUnderWorkspace(
  workspaceLocation: string,
  relativePath: string,
): string {
  if (!relativePath || relativePath.includes('\0')) {
    throw new Error(`Invalid file path "${relativePath}"`);
  }
  const base = path.resolve(workspaceLocation);
  const resolved = path.resolve(base, relativePath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Invalid file path "${relativePath}"`);
  }
  return resolved;
}

export class DirectoryExistsError extends Error {
  constructor(public readonly path: string) {
    super(`A directory already exists at ${path} — choose a different name or remove it`);
    this.name = 'DirectoryExistsError';
  }
}

export async function createWorkspaceDirectory(location: string): Promise<void> {
  // The root (env.projectsRoot / env.tempProjectsRoot) may not exist yet on
  // a fresh install, so ensure it's there before creating the leaf
  // directory. This is separate from the leaf mkdir below so a collision on
  // the leaf itself still surfaces as EEXIST rather than being silently
  // absorbed by `recursive: true`.
  await mkdir(path.dirname(location), { recursive: true });

  try {
    await mkdir(location, { recursive: false });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
      throw new DirectoryExistsError(location);
    }
    throw err;
  }
}

export function managedRoots(): string[] {
  return [env.projectsRoot, env.tempProjectsRoot];
}

// A location is "managed" only when it is a direct child of one of the
// roots — exactly the shape resolveWorkspaceLocation() produces. The root
// itself, anything nested deeper, and anything outside are all unmanaged.
// This is the safety boundary for the recursive delete below: workspaces
// created before locationRoot existed may point at a user's real repository.
export function isManagedLocation(location: string, roots: string[]): boolean {
  if (!location) return false;
  const parent = path.dirname(path.resolve(location));
  return roots.some((root) => path.resolve(root) === parent);
}

export type DirectoryRemovalResult =
  | { removed: true; path: string }
  | { removed: false; path: string; reason: 'outside-managed-roots' }
  | { removed: false; path: string; reason: 'rm-failed'; error: string };

// Best-effort removal of a workspace's directory. Never throws: an unmanaged
// location is refused without touching the filesystem, and an rm failure is
// reported rather than raised so the caller can surface it as a warning.
// `force` makes an already-missing directory a success, and rm() lstat()s the
// target, so a symlinked location removes the link rather than its target.
export async function removeWorkspaceDirectory(
  location: string,
  roots: string[] = managedRoots(),
): Promise<DirectoryRemovalResult> {
  if (!isManagedLocation(location, roots)) {
    return { removed: false, path: location, reason: 'outside-managed-roots' };
  }
  try {
    await rm(location, { recursive: true, force: true });
    return { removed: true, path: location };
  } catch (err) {
    return { removed: false, path: location, reason: 'rm-failed', error: String(err) };
  }
}
