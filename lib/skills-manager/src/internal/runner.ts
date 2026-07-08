import { readFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import vm from 'node:vm';
import type { ScriptResult } from '../types.js';

export async function runJsScript(
  scriptPath: string,
  context: Record<string, unknown> = {}
): Promise<unknown> {
  const src = await readFile(scriptPath, 'utf8');
  const sandbox = vm.createContext({ console, process: { env: process.env }, ...context });
  const script = new vm.Script(src, { filename: scriptPath });
  return script.runInContext(sandbox);
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

export async function runPythonScript(
  skillPath: string,
  scriptPath: string,
  args: string[] = []
): Promise<ScriptResult> {
  const mode = await resolveInterpreter(skillPath);

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

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, cmdArgs);
    let stdout = '';
    let stderr = '';

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => { stdout += chunk; });
    proc.stderr.on('data', (chunk: string) => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}
