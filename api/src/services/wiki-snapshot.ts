import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ExecFileFn } from './workspace-provision.js';

const execFileAsync = promisify(execFile);

// Longer than workspace-files.ts's GIT_TIMEOUT_MS (10s, for read-only branch/
// status checks) since this shells out an add + a commit rather than just
// reading state.
const SNAPSHOT_GIT_TIMEOUT_MS = 15_000;

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface SnapshotResult {
  snapshotPath: string;
}

// Copies a project's ephemeral wiki domain into its workspace directory
// before the domain is archived, so the knowledge survives independently of
// the wiki registry — Step 1 of the close process. For a non-git workspace
// this is a plain timestamped copy; for a git-connected one, the copy is
// also committed so it becomes part of the project's own history.
export async function snapshotProjectWiki(
  workspaceLocation: string,
  wikiDomainAbsPath: string,
  isGit: boolean,
  execFileFn: ExecFileFn = execFileAsync,
): Promise<SnapshotResult> {
  if (!isGit) {
    const dest = path.join(workspaceLocation, `wiki-snapshot-${isoToday()}`);
    await cp(wikiDomainAbsPath, dest, { recursive: true });
    return { snapshotPath: dest };
  }

  const dest = path.join(workspaceLocation, 'wiki');
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(wikiDomainAbsPath, dest, { recursive: true });
  await execFileFn('git', ['add', 'wiki'], {
    cwd: workspaceLocation,
    timeout: SNAPSHOT_GIT_TIMEOUT_MS,
  });
  await execFileFn('git', ['commit', '-m', 'Snapshot project wiki on close'], {
    cwd: workspaceLocation,
    timeout: SNAPSHOT_GIT_TIMEOUT_MS,
  });
  return { snapshotPath: dest };
}
