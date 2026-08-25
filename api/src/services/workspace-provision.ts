import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ExecFileFn = typeof execFileAsync;

export interface DependencyIsolationOptions {
  javascript: boolean;
  python: boolean;
}

const PROVISION_TIMEOUT_MS = 30_000;

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
