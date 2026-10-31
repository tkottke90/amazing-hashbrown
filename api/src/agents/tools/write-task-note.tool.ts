import { tool, type ToolRuntime } from '@langchain/core/tools';
import { ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import { taskFileStateSchema } from '../task-file-state.middleware.js';

const WriteTaskNoteSchema = z.object({
  note: z.string().describe('The freeform note to record for this task.'),
});

// Built fresh per automated task run (same per-construction factory pattern
// as makeUpdatePlanTool/makeCompleteTaskTool), though it no longer needs to
// close over anything of this task's own — it just returns a Command
// appending `note` to the graph's own taskState.notes via the taskState
// channel's reducer (ADR-0047). Task File persistence is handled once per
// step by TaskFileStateMiddleware's beforeModel/afterAgent hooks, not by
// this tool. Bound only in buildTaskAgent, alwaysOn in the tool catalog —
// never in interactive chat, workspace chat, or sub-agent runs.
export function makeWriteTaskNoteTool() {
  return tool(
    async (
      { note }: z.infer<typeof WriteTaskNoteSchema>,
      runtime: ToolRuntime<typeof taskFileStateSchema>,
    ) => {
      return new Command({
        update: {
          taskState: { appendNotes: [note] },
          messages: [
            new ToolMessage({
              content: 'Note recorded.',
              tool_call_id: runtime.toolCallId,
              name: 'write_task_note',
            }),
          ],
        },
      });
    },
    {
      name: 'write_task_note',
      description:
        "Record a freeform note in this task's Task File — something worth remembering " +
        'for yourself later in this run, or for whoever picks this task up next.',
      schema: WriteTaskNoteSchema,
    },
  );
}
