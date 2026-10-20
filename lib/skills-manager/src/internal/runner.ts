import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { ShellExecutor } from '@tkottke90/shell-executor';
import type { ScriptResult } from '../types.js';

let _executor: ShellExecutor | null = null;

export function setRunnerExecutor(executor: ShellExecutor): void {
  _executor = executor;
}

// Shared by runJsScript's and runPythonScript's/runShellScript's direct-spawn
// fallback path (no ShellExecutor injected). timeoutMs, when set, SIGKILLs
// the process rather than merely abandoning the wait for it — a
// Promise.race-style timeout would stop waiting but leave the real process
// running, which isn't "killed on timeout" (see
// docs/adr/0021-one-timeout-governs-all-skill-script-execution.md). Rejects
// on a spawn error (e.g. the interpreter binary doesn't exist), matching
// this module's pre-existing runPythonScript behavior.
function spawnAndCapture(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, opts.env ? { env: opts.env } : undefined);
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            proc.kill('SIGKILL');
          }, opts.timeoutMs)
        : undefined;

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout,
        stderr: timedOut
          ? `${stderr}\n[killed after exceeding ${opts.timeoutMs}ms timeout]`
          : stderr,
        exitCode: timedOut ? 1 : (code ?? 1),
      });
    });
  });
}

// Runs as a real spawned `node` process (not an in-process vm sandbox) so it
// is killable on timeout the same way runPythonScript/runShellScript already
// are (ADR-0020) — a vm.runInContext timeout only interrupts synchronous
// code, which can't bound an async script at all. The previously-documented
// `context` object (README.md) is preserved but now JSON-serialized and
// delivered via the SKILL_SCRIPT_CONTEXT env var, since a spawned process
// shares no memory with its parent to inject a live object into.
export async function runJsScript(
  scriptPath: string,
  args: string[] = [],
  context: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<ScriptResult> {
  return spawnAndCapture('node', [scriptPath, ...args], {
    env: { ...process.env, SKILL_SCRIPT_CONTEXT: JSON.stringify(context) },
    timeoutMs,
  });
}

type InterpreterMode = 'venv' | 'uv' | 'python3';

async function resolveInterpreter(skillPath: string): Promise<InterpreterMode> {
  const venvPython = join(skillPath, '.venv', 'bin', 'python');
  try {
    await access(venvPython);
    return 'venv';
  } catch {
    // no per-skill venv
  }

  const uvAvailable = await new Promise<boolean>((resolve) => {
    const proc = spawn('uv', ['--version'], { stdio: 'ignore' });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });

  return uvAvailable ? 'uv' : 'python3';
}

export function buildCommand(
  mode: InterpreterMode,
  skillPath: string,
  scriptPath: string,
  args: string[],
): string {
  const quotedArgs = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ');
  if (mode === 'venv') {
    const python = join(skillPath, '.venv', 'bin', 'python');
    return `"${python}" "${scriptPath}"${quotedArgs ? ' ' + quotedArgs : ''}`;
  } else if (mode === 'uv') {
    return `uv run "${scriptPath}"${quotedArgs ? ' ' + quotedArgs : ''}`;
  } else {
    return `python3 "${scriptPath}"${quotedArgs ? ' ' + quotedArgs : ''}`;
  }
}

export function buildShellCommand(scriptPath: string, args: string[]): string {
  const quotedArgs = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ');
  return `sh "${scriptPath}"${quotedArgs ? ' ' + quotedArgs : ''}`;
}

export async function runPythonScript(
  skillPath: string,
  scriptPath: string,
  args: string[] = [],
  timeoutMs?: number,
): Promise<ScriptResult> {
  const mode = await resolveInterpreter(skillPath);

  if (_executor) {
    const command = buildCommand(mode, skillPath, scriptPath, args);
    return _executor.execute(command, undefined, { timeoutMs });
  }

  let cmd: string;
  let cmdArgs: string[];

  if (mode === 'venv') {
    cmd = join(skillPath, '.venv', 'bin', 'python');
    cmdArgs = [scriptPath, ...args];
  } else if (mode === 'uv') {
    cmd = 'uv';
    cmdArgs = ['run', scriptPath, ...args];
  } else {
    cmd = 'python3';
    cmdArgs = [scriptPath, ...args];
  }

  return spawnAndCapture(cmd, cmdArgs, { timeoutMs });
}

export async function runShellScript(
  scriptPath: string,
  args: string[] = [],
  timeoutMs?: number,
): Promise<ScriptResult> {
  if (_executor) {
    const command = buildShellCommand(scriptPath, args);
    return _executor.execute(command, undefined, { timeoutMs });
  }

  return spawnAndCapture('sh', [scriptPath, ...args], { timeoutMs });
}
