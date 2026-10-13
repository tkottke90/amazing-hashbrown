import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { getThreadStore } from '../../services/thread-store.js';
import { getWorkspaceStore } from '../../services/workspace-store.js';
import { FINISHED_RUN_STATUSES, formatRunTranscript } from './task-run-transcript.js';

const ReadWorkspaceTaskRunSchema = z.object({
  taskId: z.string().describe('The id of the task, from list_tasks or get_task_outcome.'),
  runId: z.string().describe('The id of the run to read, from get_task_outcome.'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe('Index of the first message to return (default 0).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(40)
    .describe('Number of messages to return (default 40, max 100).'),
});

// Workspace-chat counterpart to read_task_run (read-task-run.tool.ts): that
// one is closed over a single taskId/currentRunId at construction, so an
// automated task run can only ever read its own history. This tool instead
// resolves workspaceId per call from runtime.configurable (same pattern as
// create-tasks.tool.ts), so it can read any task's run in the calling
// workspace — gated by an explicit ownership check rather than by closure.
// Named distinctly from read_task_run (never bound in the same agent) so
// traces/logs show unambiguously which security boundary handled a call.
// See docs/superpowers/specs/2026-10-13-workspace-task-visibility-design.md §3.
export const readWorkspaceTaskRunTool = tool(
  async ({ taskId, runId, offset, limit }, runtime: ToolRuntime) => {
    const workspaceId = runtime.configurable?.workspaceId as string | undefined;
    if (!workspaceId) {
      return 'Cannot look up tasks: no active workspace.';
    }

    const store = getWorkspaceStore();
    const task = store.getTask(taskId);
    if (!task || task.workspaceId !== workspaceId) {
      return `No task with id "${taskId}" in this workspace.`;
    }

    const run = store.getTaskRun(runId);
    if (!run || run.taskId !== taskId) {
      return `No run with id "${runId}" belongs to task "${taskId}".`;
    }
    if (!FINISHED_RUN_STATUSES.has(run.status)) {
      return `Run #${run.runNumber} has not finished yet (status: ${run.status}), so it has no transcript to read.`;
    }
    if (!run.threadId) {
      return (
        `Run #${run.runNumber} predates per-run transcripts, so only its summary is available: ` +
        (run.summary ?? '(no summary recorded)')
      );
    }

    return formatRunTranscript(getThreadStore(), run, offset, limit);
  },
  {
    name: 'read_workspace_task_run',
    description: 'Read the transcript of a past run of any task in this workspace.',
    schema: ReadWorkspaceTaskRunSchema,
  },
);
