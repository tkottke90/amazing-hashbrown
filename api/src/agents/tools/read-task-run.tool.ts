import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getThreadStore } from '../../services/thread-store.js';
import { getWorkspaceStore } from '../../services/workspace-store.js';
import { FINISHED_RUN_STATUSES, formatRunTranscript } from './task-run-transcript.js';

const ReadTaskRunSchema = z.object({
  runId: z
    .string()
    .describe('The id of the previous run to read, as given in the kickoff message.'),
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

// Built fresh per automated task run, closed over that run's own task and
// queue entry (the same per-construction pattern as makeCompleteTaskTool),
// so the model only ever names a runId — it can't read another task's
// threads, or the run it is currently in. buildTaskAgent binds it only when
// the task has at least one finished run with a transcript; the run's
// kickoff message spells out the exact call, so the system prompt never
// mentions it. See docs/superpowers/specs/2026-09-26-cron-task-triggers-design.md §3.
export function makeReadTaskRunTool(taskId: string, currentRunId: string) {
  return tool(
    async ({ runId, offset, limit }) => {
      const run = getWorkspaceStore().getTaskRun(runId);
      if (!run || run.taskId !== taskId) {
        return `No run with id "${runId}" belongs to this task. Use a run id listed in the kickoff message.`;
      }
      if (run.id === currentRunId) {
        return 'That is the run you are currently in — its history is already in your context.';
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
      name: 'read_task_run',
      description: 'Read the transcript of a previous run of this task.',
      schema: ReadTaskRunSchema,
    },
  );
}
