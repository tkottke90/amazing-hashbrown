import { mkdir } from 'node:fs/promises';
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
      throw new Error('A directory already exists at this location — choose a different name');
    }
    throw err;
  }
}
