import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const CompleteTaskSchema = z.object({
  outcome: z
    .enum(['done', 'failed'])
    .describe('"done" if the task\'s outcome was met, "failed" if you cannot proceed further.'),
  summary: z.string().describe('A short summary of what was accomplished or why it failed.'),
});

// Built fresh per automated task run, closed over that specific task's id
// (mirrors makeWikiCreatePageTool's per-construction factory pattern) — this
// tool never appears in interactive chat/workspace-chat agents. Completion
// itself is detected by task-execution.ts tapping this tool's call in the
// agent's event stream, not by its return value.
export function makeCompleteTaskTool(taskId: string) {
  return tool(
    async ({ outcome, summary }: z.infer<typeof CompleteTaskSchema>) =>
      `Task ${taskId} marked ${outcome}: ${summary}`,
    {
      name: 'complete_task',
      description:
        "Call this when the task's outcome has been met, or when you cannot proceed further. " +
        'This ends the automated run.',
      schema: CompleteTaskSchema,
    },
  );
}
