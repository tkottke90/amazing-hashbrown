import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExecFileFn } from './workspace-provision.js';
import { env } from '../config/env.js';
import { buildGitAuthArgs } from './git-credentials.js';

const execFileAsync = promisify(execFile);

const GIT_READ_TIMEOUT_MS = 10_000;
const GIT_NETWORK_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  dirty: boolean;
}

// Parses `git status --porcelain=2 --branch` output. The v2 header lines
// (branch.head/branch.upstream/branch.ab) give branch/upstream/ahead-behind
// in one call, and any non-header line present means the tree is dirty — a
// single shell-out instead of the three separate calls this would otherwise
// need.
export function parseStatusPorcelainV2(output: string): GitStatus {
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let dirty = false;

  for (const line of output.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      branch = head === '(detached)' ? null : head;
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (!line.startsWith('#')) {
      dirty = true;
    }
  }

  return { branch, upstream, ahead, behind, hasRemote: upstream !== null, dirty };
}

export async function getGitStatus(
  location: string,
  execFileFn: ExecFileFn = execFileAsync,
): Promise<GitStatus> {
  const result = await execFileFn('git', ['status', '--porcelain=2', '--branch'], {
    cwd: location,
    timeout: GIT_READ_TIMEOUT_MS,
  });
  return parseStatusPorcelainV2(result.stdout);
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export interface GitBranches {
  local: string[];
  remote: string[];
}

export async function listBranches(
  location: string,
  execFileFn: ExecFileFn = execFileAsync,
): Promise<GitBranches> {
  const result = await execFileFn(
    'git',
    ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'],
    { cwd: location, timeout: GIT_READ_TIMEOUT_MS },
  );

  const local: string[] = [];
  const remote: string[] = [];

  for (const line of result.stdout.split('\n')) {
    const refname = line.trim();
    if (!refname) continue;

    if (refname.startsWith('refs/heads/')) {
      local.push(refname.slice('refs/heads/'.length));
    } else if (refname.startsWith('refs/remotes/')) {
      const name = refname.slice('refs/remotes/'.length);
      // refs/remotes/<remote>/HEAD is a symbolic ref to the remote's default
      // branch, not a branch of its own — excluded so it never shows up
      // as a selectable entry.
      if (name.endsWith('/HEAD')) continue;
      remote.push(name);
    }
  }

  return { local, remote };
}

// ---------------------------------------------------------------------------
// Commit history (shared task progress record — issue #302)
// ---------------------------------------------------------------------------
// Read-only, same category as getGitStatus/listBranches above — no
// withLock. NOTE: origin='agent' sub-agent tasks run concurrently against
// the same workspace.location (dequeueNext() exempts them from the
// per-workspace scope lock — see workspace-store.ts), so a concurrently-
// running sibling's own commits can land between a task's startSha capture
// and its endSha read. This is an accepted, documented limitation — no new
// locking is added here. See
// docs/superpowers/specs/2026-10-15-shared-task-progress-record-design.md.
//
// Unlike branch names (see assertSafeRefName below), the SHAs passed to
// these helpers are always harness-derived (from getHeadCommit itself, or
// stored state), never user-supplied ref names — there is no flag-injection
// surface here to guard against.

// null on an unborn HEAD (a repo with no commits yet) — the one case where
// `git rev-parse HEAD` exits non-zero without the caller having done
// anything wrong, so (unlike every other helper in this file) this needs
// its own try/catch to turn that failure into a meaningful null rather than
// letting it propagate as a rejected promise.
export async function getHeadCommit(
  location: string,
  execFileFn: ExecFileFn = execFileAsync,
): Promise<string | null> {
  try {
    const result = await execFileFn('git', ['rev-parse', 'HEAD'], {
      cwd: location,
      timeout: GIT_READ_TIMEOUT_MS,
    });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

// fromSha === null means the first-commit case (no prior HEAD to diff
// against) — falls back to every file currently tracked, via `git
// ls-files`, rather than a `git diff` with no base to compare to.
export async function getChangedFiles(
  location: string,
  fromSha: string | null,
  toSha: string,
  execFileFn: ExecFileFn = execFileAsync,
): Promise<string[]> {
  const result =
    fromSha === null
      ? await execFileFn('git', ['ls-files'], { cwd: location, timeout: GIT_READ_TIMEOUT_MS })
      : await execFileFn('git', ['diff', '--name-only', fromSha, toSha], {
          cwd: location,
          timeout: GIT_READ_TIMEOUT_MS,
        });
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// fromSha === null means there was no prior HEAD — toSha (the repo's first
// commit) is itself the only commit "between" nothing and toSha.
export async function getCommitsBetween(
  location: string,
  fromSha: string | null,
  toSha: string,
  execFileFn: ExecFileFn = execFileAsync,
): Promise<string[]> {
  if (fromSha === null) return [toSha];
  const result = await execFileFn('git', ['log', '--format=%H', `${fromSha}..${toSha}`], {
    cwd: location,
    timeout: GIT_READ_TIMEOUT_MS,
  });
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// Fallback source for "files touched" when a run made no commits — getGitStatus
// above only exposes a boolean `dirty`, not the actual paths, so this is a
// separate small helper rather than extending that one's porcelain=2 parser.
// Plain `git status --porcelain` (v1, not v2) lines are "XY PATH" or, for a
// rename, "XY ORIG -> PATH" — this takes the text after "-> " when present,
// else everything after the two status characters and the following space.
export async function getDirtyFiles(
  location: string,
  execFileFn: ExecFileFn = execFileAsync,
): Promise<string[]> {
  const result = await execFileFn('git', ['status', '--porcelain'], {
    cwd: location,
    timeout: GIT_READ_TIMEOUT_MS,
  });
  const files: string[] = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const renameSplit = line.indexOf(' -> ');
    const path = renameSplit !== -1 ? line.slice(renameSplit + 4) : line.slice(3);
    files.push(path.trim());
  }
  return files;
}

// git ref names can never start with "-" (git check-ref-format rejects
// them), so any value that does is already an invalid ref — rejecting it
// here, before it ever reaches execFile, is both correct and the only
// reliable flag-injection guard available. Unlike `git clone`/`git push`,
// `git checkout`/`git checkout -b` have no `--` placement that both (a)
// blocks a leading-dash argument from being parsed as a flag and (b) still
// lets that argument name a branch — `--` before it makes git treat it as a
// pathspec instead of a ref, which is a different (and wrong) operation.
function assertSafeRefName(value: string): void {
  if (!value || value.startsWith('-')) {
    throw new Error(`Invalid git ref name "${value}"`);
  }
}

// ---------------------------------------------------------------------------
// Auth error translation
// ---------------------------------------------------------------------------

export type GitNetworkOperation = 'clone' | 'fetch' | 'push';

// Git's own stderr on this failure ("fatal: could not read Username for
// 'https://github.com': No such device or address") gives the user no
// actionable next step — there's no TTY to prompt on and no credential
// helper configured. execFile's rejection typically wraps that stderr
// inside a larger "Command failed: ..." message, so this matches as a
// substring, not an exact string. Any other git error (merge conflict,
// network failure, repo not found, a token present but lacking access)
// passes through unchanged.
const GIT_AUTH_ERROR_SNIPPET = 'could not read Username for';

export function translateGitAuthError(message: string, operation: GitNetworkOperation): string {
  if (!message.includes(GIT_AUTH_ERROR_SNIPPET)) return message;
  return (
    `Git ${operation} failed: no GitHub credentials are configured for workspace git ` +
    'operations. Add a token in Settings → Workspaces → Git.'
  );
}

// ---------------------------------------------------------------------------
// Fetch / sync / push
// ---------------------------------------------------------------------------

export async function fetchRemote(
  location: string,
  execFileFn: ExecFileFn = execFileAsync,
  token: string | undefined = env.workspaces.git?.github?.token,
): Promise<void> {
  const authArgs = buildGitAuthArgs(token);
  try {
    await execFileFn('git', [...authArgs, 'fetch'], {
      cwd: location,
      timeout: GIT_NETWORK_TIMEOUT_MS,
    });
  } catch (err) {
    throw new Error(
      translateGitAuthError(err instanceof Error ? err.message : String(err), 'fetch'),
    );
  }
}

// Fetch, then fast-forward-only merge — refuses (git's own error surfaces
// unmodified) rather than auto-resolving a conflict or a diverged history.
// The merge is local — no network, no credentials needed.
export async function syncFastForward(
  location: string,
  execFileFn: ExecFileFn = execFileAsync,
  token: string | undefined = env.workspaces.git?.github?.token,
): Promise<void> {
  await fetchRemote(location, execFileFn, token);
  await execFileFn('git', ['merge', '--ff-only', '@{u}'], {
    cwd: location,
    timeout: GIT_NETWORK_TIMEOUT_MS,
  });
}

async function hasUpstream(location: string, execFileFn: ExecFileFn): Promise<boolean> {
  try {
    await execFileFn('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
      cwd: location,
      timeout: GIT_READ_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

async function getCurrentBranch(location: string, execFileFn: ExecFileFn): Promise<string> {
  const result = await execFileFn('git', ['branch', '--show-current'], {
    cwd: location,
    timeout: GIT_READ_TIMEOUT_MS,
  });
  return result.stdout.trim();
}

// Plain `git push` once the current branch already tracks a remote branch;
// otherwise sets the upstream on this first push (`git push -u origin
// <branch>`) so Push always works once a remote exists, rather than
// requiring the caller to have configured tracking beforehand.
export async function pushBranch(
  location: string,
  execFileFn: ExecFileFn = execFileAsync,
  token: string | undefined = env.workspaces.git?.github?.token,
): Promise<void> {
  const authArgs = buildGitAuthArgs(token);
  try {
    if (await hasUpstream(location, execFileFn)) {
      await execFileFn('git', [...authArgs, 'push'], {
        cwd: location,
        timeout: GIT_NETWORK_TIMEOUT_MS,
      });
      return;
    }

    const branch = await getCurrentBranch(location, execFileFn);
    await execFileFn('git', [...authArgs, 'push', '-u', 'origin', '--', branch], {
      cwd: location,
      timeout: GIT_NETWORK_TIMEOUT_MS,
    });
  } catch (err) {
    throw new Error(
      translateGitAuthError(err instanceof Error ? err.message : String(err), 'push'),
    );
  }
}

// ---------------------------------------------------------------------------
// Checkout / create branch
// ---------------------------------------------------------------------------

export async function checkoutBranch(
  location: string,
  branch: string,
  execFileFn: ExecFileFn = execFileAsync,
): Promise<void> {
  assertSafeRefName(branch);
  await execFileFn('git', ['checkout', branch], { cwd: location, timeout: GIT_READ_TIMEOUT_MS });
}

export async function createBranch(
  location: string,
  name: string,
  from?: string,
  execFileFn: ExecFileFn = execFileAsync,
): Promise<void> {
  assertSafeRefName(name);
  if (from) assertSafeRefName(from);

  const args = from ? ['checkout', '-b', name, from] : ['checkout', '-b', name];
  await execFileFn('git', args, { cwd: location, timeout: GIT_READ_TIMEOUT_MS });
}

// ---------------------------------------------------------------------------
// Concurrency lock
// ---------------------------------------------------------------------------

export class GitOperationInProgressError extends Error {
  constructor(workspaceId: string) {
    super(`A git operation is already running for workspace ${workspaceId}`);
    this.name = 'GitOperationInProgressError';
  }
}

const locked = new Set<string>();

// Guards the mutating operations above (fetch/sync/push/checkout/create)
// against overlapping calls on the same workspace racing on git's own
// index.lock — read-only calls (getGitStatus/listBranches) never take this
// lock, so status can still be read while a mutation is in flight.
export async function withLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  if (locked.has(workspaceId)) {
    throw new GitOperationInProgressError(workspaceId);
  }
  locked.add(workspaceId);
  try {
    return await fn();
  } finally {
    locked.delete(workspaceId);
  }
}
