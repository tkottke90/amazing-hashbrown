import { tool } from '@langchain/core/tools';
import { interrupt } from '@langchain/langgraph';
import { z } from 'zod';
import { ShellExecutor, ShellExecutorConfigSchema } from '@tkottke90/shell-executor';
import type { ApprovalCallback } from '@tkottke90/shell-executor';
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

// workingDirectory overrides the configured cwd — passed by workspace/task
// agent builds so commands run inside that workspace's own directory
// (workspace.location) instead of the global tools.shell.workingDirectory
// default. Omitted for plain (non-workspace) chat, which has no directory
// to bind to.
export function makeShellExecTool(workingDirectory?: string) {
  return tool(
    async (input: z.infer<typeof ShellExecSchema>) => {
      const { command, reason, threadId } = input;
      const baseConfig = env.tools?.shell ?? ShellExecutorConfigSchema.parse({});
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
        // fetched lazily so store is guaranteed to be initialised
        auditWriter: (() => {
          try {
            return getShellAuditWriter();
          } catch {
            return undefined;
          }
        })(),
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
