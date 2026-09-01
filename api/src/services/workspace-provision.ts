import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

// Provisions the git repository implied by a workspace's git flag/remoteUrl,
// before any dependency isolation runs (git clone requires an empty target
// directory). remoteUrl is passed after `--` so a malformed/malicious value
// can never be parsed as a git flag instead of a URL.
export async function provisionGitRepository(
  location: string,
  opts: GitProvisionOptions,
  execFileFn: ExecFileFn = execFileAsync,
): Promise<void> {
  if (!opts.git) return;

  const remoteUrl = opts.remoteUrl?.trim();
  if (remoteUrl) {
    await execFileFn('git', ['clone', '--', remoteUrl, '.'], {
      cwd: location,
      timeout: GIT_CLONE_TIMEOUT_MS,
    });
  } else {
    await execFileFn('git', ['init'], { cwd: location, timeout: GIT_INIT_TIMEOUT_MS });
  }
}
