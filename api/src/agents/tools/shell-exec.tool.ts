import { tool } from '@langchain/core/tools';
import { interrupt } from '@langchain/langgraph';
import { z } from 'zod';
import {
  ShellExecutor,
  ShellExecutorConfigSchema,
  detectLongSleep,
} from '@tkottke90/shell-executor';
import type { ApprovalCallback, AuditWriter } from '@tkottke90/shell-executor';
import { env } from '../../config/env.js';
import { getShellAuditWriter } from '../../services/shell-audit.js';

// In-memory session allowlist: patterns the user approved with "approve and remember"
// within the current process lifetime. Keyed by threadId.
const _sessionPatterns = new Map<string, string[]>();

function getSessionPatterns(threadId: string): string[] {
  return _sessionPatterns.get(threadId) ?? [];
}

function appendSessionPattern(threadId: string, pattern: string): void {
  const existing = _sessionPatterns.get(threadId) ?? [];
  _sessionPatterns.set(threadId, [...existing, pattern]);
}

export const ShellExecSchema = z.object({
  command: z.string().describe('The shell command to execute'),
  reason: z
    .string()
    .min(1, 'reason is required')
    .describe('Explain why this command is needed (shown to user if approval is required)'),
  threadId: z.string().optional().describe('Thread ID for session allowlist scoping'),
});

// Refusal returned when a command waits by sleeping (detectLongSleep).
// Names schedule_wakeup only when the agent actually has it bound. See
// docs/superpowers/specs/2026-09-27-agent-wait-design.md §5.
export function longSleepRefusal(seconds: number, wakeupAvailable: boolean): string {
  const duration = Number.isFinite(seconds) ? `${seconds}s` : 'forever';
  return wakeupAvailable
    ? `Refused: this command sleeps for ${duration}. Don't wait inside the shell — call schedule_wakeup with your delay and a note, then end your turn.`
    : `Refused: this command sleeps for ${duration}. Long sleeps aren't allowed in shell_exec.`;
}

// fetched lazily so the store is guaranteed to be initialised; absent in
// unit tests that never boot it.
function resolveAuditWriter(): AuditWriter | undefined {
  try {
    return getShellAuditWriter();
  } catch {
    return undefined;
  }
}

export interface ShellExecToolOptions {
  // True for agents that also bind schedule_wakeup (chat, workspace chat) —
  // the sleep-guard refusal then tells the agent to use it.
  wakeupAvailable?: boolean;
}

// workingDirectory overrides the configured cwd — passed by workspace/task
// agent builds so commands run inside that workspace's own directory
// (workspace.location) instead of the global tools.shell.workingDirectory
// default. Omitted for plain (non-workspace) chat, which has no directory
// to bind to.
export function makeShellExecTool(workingDirectory?: string, options: ShellExecToolOptions = {}) {
  return tool(
    async (input: z.infer<typeof ShellExecSchema>) => {
      const { command, reason, threadId } = input;

      // Before policy, trust-all and the approval interrupt: a long sleep is
      // refused outright, so the user is never asked to approve a command
      // that would only tie up the turn.
      const sleepSeconds = detectLongSleep(command);
      if (sleepSeconds !== null) {
        await resolveAuditWriter()?.({
          timestamp: new Date().toISOString(),
          command,
          outcome: 'denied',
          source: 'sleep-guard',
          threadId,
          trustAll: false,
        });
        return longSleepRefusal(sleepSeconds, options.wakeupAvailable ?? false);
      }

      const baseConfig = ShellExecutorConfigSchema.parse(env.tools['shell_exec'] ?? {});
      const config = workingDirectory ? { ...baseConfig, workingDirectory } : baseConfig;
      const sessionAllowlist = threadId ? getSessionPatterns(threadId) : [];

      const onApprovalRequired: ApprovalCallback = async (cmd, rsn) => {
        // interrupt() suspends the graph. Returns the user's answer on resume.
        const answer = interrupt({
          kind: 'shell_approval',
          command: cmd,
          reason: rsn,
        }) as string;

        if (answer === 'approved_remember' && threadId) {
          appendSessionPattern(threadId, cmd);
          return 'approved';
        }

        return answer === 'approved' || answer === 'approved_remember' ? 'approved' : 'denied';
      };

      const executor = new ShellExecutor(config, {
        sessionAllowlist,
        onApprovalRequired,
        auditWriter: resolveAuditWriter(),
      });

      const result = await executor.execute(command, reason);

      const parts: string[] = [`exit ${result.exitCode}`];
      if (result.stdout) parts.push(result.stdout);
      if (result.stderr) parts.push(result.stderr);
      return parts.join('\n');
    },
    {
      name: 'shell_exec',
      description:
        'Execute a shell command in the configured working directory. ' +
        'Commands that are not on the policy allowlist require user approval before running. ' +
        'Always provide a clear reason so the user understands why the command is needed.',
      schema: ShellExecSchema,
    },
  );
}
