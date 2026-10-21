import { tool, type ToolRuntime } from '@langchain/core/tools';
import { ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { z } from 'zod';
import { getWorkspaceStore, type WorkspaceStore } from '../../services/workspace-store.js';
import { writeTaskFile, type TaskState } from '../../services/task-file.js';
import { taskFileStateSchema } from '../task-file-state.middleware.js';
import { logger, serializeError } from '../../config/logger.js';

const WriteTaskNoteSchema = z.object({
  note: z.string().describe('The freeform note to record for this task.'),
});

// Built fresh per automated task run, closed over that task's id and its
// Task File path (same per-construction factory pattern as
// makeUpdatePlanTool/makeCompleteTaskTool). Appends to the CURRENT run's
// notes segment (the last entry of taskState.notes — task-execution.ts
// pushes a fresh one at the start of a genuinely new run) and returns a
// Command updating the graph's own taskState directly from this tool's own
// return value — see ADR-0037 and
// docs/superpowers/specs/2026-10-21-workspace-task-files-design.md §4.
// Bound only in buildTaskAgent, alwaysOn in the tool catalog — never in
// interactive chat, workspace chat, or sub-agent runs.
export function makeWriteTaskNoteTool(taskId: string, filePath: string, store?: WorkspaceStore) {
  return tool(
    async (
      { note }: z.infer<typeof WriteTaskNoteSchema>,
      runtime: ToolRuntime<typeof taskFileStateSchema>,
    ) => {
      const s = store ?? getWorkspaceStore();
      const task = s.getTask(taskId);
      const title = task?.title ?? taskId;

      const current = runtime.state.taskState;
      const notes = current.notes.length > 0 ? current.notes : [[]];
      const lastSegment = notes[notes.length - 1] ?? [];
      const nextNotes = [...notes.slice(0, -1), [...lastSegment, note]];
      const nextState: TaskState = { ...current, notes: nextNotes };

      try {
        await writeTaskFile(filePath, nextState, { taskId, title });
      } catch (err) {
        // I/O failure must never fail the tool call — the agent's note is
        // still reflected in graph state even if the on-disk mirror lags.
        logger.warn('write-task-note: failed to write Task File', {
          taskId,
          filePath,
          err: serializeError(err),
        });
      }

      return new Command({
        update: {
          taskState: nextState,
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
