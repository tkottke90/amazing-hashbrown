import { spawn } from 'node:child_process';
import type { ShellExecutorConfig } from './config.js';
import type { AuditWriter, AuditEntry } from './audit.js';
import type { ApprovalCallback, ShellCommandResult } from './types.js';
import { evaluatePolicy } from './policy.js';

type ShellExecutorOptions = {
  trustAll?: boolean;
  sessionAllowlist?: string[];
  onApprovalRequired?: ApprovalCallback;
  auditWriter?: AuditWriter;
};

const ERROR_RESULT = (message: string): ShellCommandResult => ({
  stdout: '',
  stderr: message,
  exitCode: 1,
});

function spawnCommand(
  command: string,
  config: ShellExecutorConfig,
): Promise<ShellCommandResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, {
      shell: true,
      cwd: config.workingDirectory,
      env: config.env as NodeJS.ProcessEnv,
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');

    proc.stdout?.on('data', (chunk: string) => stdoutChunks.push(chunk));
    proc.stderr?.on('data', (chunk: string) => stderrChunks.push(chunk));

    proc.on('close', (code: number | null) => {
      resolve({
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        exitCode: code ?? 1,
      });
    });

    proc.on('error', (err: Error) => {
      resolve(ERROR_RESULT(`Process error: ${err.message}`));
    });
  });
}

export class ShellExecutor {
  private config: ShellExecutorConfig;
  private trustAll: boolean;
  private sessionAllowlist: string[];
  private onApprovalRequired?: ApprovalCallback;
  private auditWriter?: AuditWriter;

  constructor(config: ShellExecutorConfig, opts: ShellExecutorOptions = {}) {
    this.config = config;
    this.trustAll = opts.trustAll ?? false;
    this.sessionAllowlist = opts.sessionAllowlist ?? [];
    this.onApprovalRequired = opts.onApprovalRequired;
    this.auditWriter = opts.auditWriter;
  }

  async execute(command: string, reason?: string): Promise<ShellCommandResult> {
    if (this.trustAll) {
      await this.audit({ command, outcome: 'allowed', source: 'trust', trustAll: true });
      const result = await spawnCommand(command, this.config);
      await this.audit({
        command,
        outcome: result.exitCode === 0 ? 'allowed' : 'error',
        source: 'trust',
        trustAll: true,
        exitCode: result.exitCode,
      });
      return result;
    }

    const policyOutcome = evaluatePolicy(command, this.config);

    if (policyOutcome === 'denied') {
      await this.audit({ command, outcome: 'denied', source: 'policy', trustAll: false });
      return ERROR_RESULT(`Command denied by policy: ${command}`);
    }

    if (policyOutcome === 'allowed') {
      await this.audit({ command, outcome: 'allowed', source: 'policy', trustAll: false });
      const result = await spawnCommand(command, this.config);
      await this.audit({
        command,
        outcome: result.exitCode === 0 ? 'allowed' : 'error',
        source: 'policy',
        trustAll: false,
        exitCode: result.exitCode,
      });
      return result;
    }

    // policyOutcome === 'requires-approval' — check session allowlist first
    const sessionMatch = this.sessionAllowlist.some((pattern) => {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp(`^${escaped}$`).test(command);
    });

    if (sessionMatch) {
      await this.audit({ command, outcome: 'allowed', source: 'session-memory', trustAll: false });
      const result = await spawnCommand(command, this.config);
      await this.audit({
        command,
        outcome: result.exitCode === 0 ? 'allowed' : 'error',
        source: 'session-memory',
        trustAll: false,
        exitCode: result.exitCode,
      });
      return result;
    }

    if (!this.onApprovalRequired) {
      await this.audit({ command, outcome: 'denied', source: 'user', trustAll: false });
      return ERROR_RESULT(
        `Command requires approval but no approval callback is configured: ${command}`,
      );
    }

    const decision = await this.onApprovalRequired(command, reason);

    if (decision === 'denied') {
      await this.audit({ command, outcome: 'rejected', source: 'user', trustAll: false });
      return ERROR_RESULT(`Command rejected by user: ${command}`);
    }

    await this.audit({ command, outcome: 'approved', source: 'user', trustAll: false });
    const result = await spawnCommand(command, this.config);
    await this.audit({
      command,
      outcome: result.exitCode === 0 ? 'approved' : 'error',
      source: 'user',
      trustAll: false,
      exitCode: result.exitCode,
    });
    return result;
  }

  private async audit(entry: Omit<AuditEntry, 'timestamp'>): Promise<void> {
    if (!this.auditWriter) return;
    try {
      await this.auditWriter({ ...entry, timestamp: new Date().toISOString() });
    } catch {
      // audit failures must not propagate
    }
  }
}
