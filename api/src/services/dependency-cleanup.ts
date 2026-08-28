import { rm, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveFilePathUnderWorkspace } from './workspace-location.js';

interface DependencyTarget {
  relPath: string;
  flag: 'javascript' | 'python';
}

// Every path a project close's dependency-cleanup step knows how to find and
// remove, gated by the workspace's javascript/python isolation flags (R3 of
// the design doc's Step 3).
const TARGETS: DependencyTarget[] = [
  { relPath: 'node_modules', flag: 'javascript' },
  { relPath: 'venv', flag: 'python' },
  { relPath: '.venv', flag: 'python' },
  { relPath: '__pycache__', flag: 'python' },
];

export interface DependencyScanEntry {
  path: string;
  sizeBytes: number;
}

async function dirSize(absPath: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(absPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(absPath, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(full);
    } else {
      try {
        total += (await stat(full)).size;
      } catch {
        // Removed/unreadable between readdir and stat — skip it.
      }
    }
  }
  return total;
}

/** Which of the flag-gated dependency directories actually exist on disk,
 * with their sizes. Used both for the pre-cleanup "found directories" list
 * and, once nothing is found, to auto-skip the cleanup step. */
export async function scanDependencyTargets(
  workspaceLocation: string,
  opts: { javascript: boolean; python: boolean },
): Promise<DependencyScanEntry[]> {
  const candidates = TARGETS.filter((t) => opts[t.flag]);
  const found: DependencyScanEntry[] = [];
  for (const target of candidates) {
    const abs = resolveFilePathUnderWorkspace(workspaceLocation, target.relPath);
    try {
      await stat(abs);
    } catch {
      continue; // not present
    }
    found.push({ path: target.relPath, sizeBytes: await dirSize(abs) });
  }
  return found;
}

export interface RemoveDependencyTargetsResult {
  removed: string[];
  bytesFreed: number;
}

/** Removes the given (already-scanned) relative paths from disk. Every path
 * is re-resolved through resolveFilePathUnderWorkspace — never trusts a
 * caller-supplied path beyond the workspace root. */
export async function removeDependencyTargets(
  workspaceLocation: string,
  relPaths: string[],
): Promise<RemoveDependencyTargetsResult> {
  let bytesFreed = 0;
  const removed: string[] = [];
  for (const relPath of relPaths) {
    const abs = resolveFilePathUnderWorkspace(workspaceLocation, relPath);
    let size = 0;
    try {
      size = await dirSize(abs);
    } catch {
      continue; // already gone
    }
    await rm(abs, { recursive: true, force: true });
    bytesFreed += size;
    removed.push(relPath);
  }
  return { removed, bytesFreed };
}
