import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExecFileFn } from './workspace-provision.js';

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
// Fetch / sync / push
// ---------------------------------------------------------------------------

export async function fetchRemote(
  location: string,
  execFileFn: ExecFileFn = execFileAsync,
): Promise<void> {
  await execFileFn('git', ['fetch'], { cwd: location, timeout: GIT_NETWORK_TIMEOUT_MS });
}

// Fetch, then fast-forward-only merge — refuses (git's own error surfaces
// unmodified) rather than auto-resolving a conflict or a diverged history.
export async function syncFastForward(
  location: string,
  execFileFn: ExecFileFn = execFileAsync,
): Promise<void> {
  await execFileFn('git', ['fetch'], { cwd: location, timeout: GIT_NETWORK_TIMEOUT_MS });
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
): Promise<void> {
  if (await hasUpstream(location, execFileFn)) {
    await execFileFn('git', ['push'], { cwd: location, timeout: GIT_NETWORK_TIMEOUT_MS });
    return;
  }

  const branch = await getCurrentBranch(location, execFileFn);
  await execFileFn('git', ['push', '-u', 'origin', '--', branch], {
    cwd: location,
    timeout: GIT_NETWORK_TIMEOUT_MS,
  });
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
