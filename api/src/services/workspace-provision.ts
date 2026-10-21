import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { buildGitAuthArgs } from './git-credentials.js';
import { translateGitAuthError } from './workspace-git.js';
import { logger, serializeError } from '../config/logger.js';

const execFileAsync = promisify(execFile);

export type ExecFileFn = typeof execFileAsync;

export interface DependencyIsolationOptions {
  javascript: boolean;
  python: boolean;
}

export interface GitProvisionOptions {
  git: boolean;
  remoteUrl?: string | null;
}

const PROVISION_TIMEOUT_MS = 30_000;
const GIT_CLONE_TIMEOUT_MS = 60_000;
const GIT_INIT_TIMEOUT_MS = 10_000;

// Scaffolds the layout implied by a workspace's javascript/python isolation
// flags — `npm init -y` / `python3 -m venv .venv` — never `install`, so no
// third-party code or install hooks ever run and no network call is made.
// execFileFn is injectable so callers can stub it out in tests instead of
// depending on npm/python3 actually being on PATH.
export async function provisionDependencyIsolation(
  location: string,
  opts: DependencyIsolationOptions,
  execFileFn: ExecFileFn = execFileAsync,
): Promise<void> {
  if (opts.javascript) {
    await execFileFn('npm', ['init', '-y'], { cwd: location, timeout: PROVISION_TIMEOUT_MS });
  }
  if (opts.python) {
    await execFileFn('python3', ['-m', 'venv', '.venv'], {
      cwd: location,
      timeout: PROVISION_TIMEOUT_MS,
    });
  }
}

const HASHBROWN_GITIGNORE_LINE = '.hashbrown/';

// Ensures `.hashbrown/` is excluded from the workspace's own git history —
// closes a pre-existing gap where `.hashbrown/summaries/*.md`
// (workspace-summarizer.ts) could already end up untracked/stageable in a
// user's real project, and the new `.hashbrown/tasks/*.md` (Task Files)
// doubles that generated-file footprint. Mechanical: the user and agent
// never have to think about it (ADR-0040). Creates a fresh one-line
// `.gitignore` if none exists; otherwise appends only if not already
// covered, never overwriting what's there. A failure here is logged and
// swallowed — it's a hygiene nicety, not a reason to fail provisioning.
async function ensureHashbrownGitignore(location: string): Promise<void> {
  const gitignorePath = path.join(location, '.gitignore');
  try {
    let existing: string | null = null;
    try {
      existing = await readFile(gitignorePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    if (existing === null) {
      await writeFile(gitignorePath, `${HASHBROWN_GITIGNORE_LINE}\n`, 'utf8');
      return;
    }

    const alreadyCovered = existing
      .split('\n')
      .some((line) => line.trim() === HASHBROWN_GITIGNORE_LINE || line.trim() === '.hashbrown');
    if (alreadyCovered) return;

    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await writeFile(gitignorePath, `${existing}${separator}${HASHBROWN_GITIGNORE_LINE}\n`, 'utf8');
  } catch (err) {
    logger.warn('workspace-provision: failed to ensure .hashbrown/ is gitignored', {
      location,
      err: serializeError(err),
    });
  }
}

// Provisions the git repository implied by a workspace's git flag/remoteUrl,
// before any dependency isolation runs (git clone requires an empty target
// directory). remoteUrl is passed after `--` so a malformed/malicious value
// can never be parsed as a git flag instead of a URL.
export async function provisionGitRepository(
  location: string,
  opts: GitProvisionOptions,
  execFileFn: ExecFileFn = execFileAsync,
  token: string | undefined = env.workspaces.git?.github?.token,
): Promise<void> {
  if (!opts.git) return;

  const remoteUrl = opts.remoteUrl?.trim();
  if (remoteUrl) {
    const authArgs = buildGitAuthArgs(token);
    try {
      await execFileFn('git', [...authArgs, 'clone', '--', remoteUrl, '.'], {
        cwd: location,
        timeout: GIT_CLONE_TIMEOUT_MS,
      });
    } catch (err) {
      throw new Error(
        translateGitAuthError(err instanceof Error ? err.message : String(err), 'clone'),
      );
    }
  } else {
    await execFileFn('git', ['init'], { cwd: location, timeout: GIT_INIT_TIMEOUT_MS });
  }

  await ensureHashbrownGitignore(location);
}
