import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { getWorkspaceStore, type WorkspaceStore } from '../../services/workspace-store.js';
import { renderTaskStateToMarkdown } from '../../services/task-file.js';
import { taskFileStateSchema } from '../task-file-state.middleware.js';

const ReadTaskNotesSchema = z.object({});

// Built fresh per automated task run, closed over that task's id (same
// per-construction factory pattern as makeWriteTaskNoteTool). Returns the
// current rendered Task File content straight from in-memory graph state,
// never the disk — every mutation path (write_task_note, update_plan)
// writes through to the file immediately, so the two are identical by
// construction. Bound only in buildTaskAgent, alwaysOn in the tool
// catalog — never in interactive chat, workspace chat, or sub-agent runs.
export function makeReadTaskNotesTool(taskId: string, store?: WorkspaceStore) {
  return tool(
    async (
      _args: z.infer<typeof ReadTaskNotesSchema>,
      runtime: ToolRuntime<typeof taskFileStateSchema>,
    ) => {
      const s = store ?? getWorkspaceStore();
      const task = s.getTask(taskId);
      const title = task?.title ?? taskId;
      return renderTaskStateToMarkdown(runtime.state.taskState, { taskId, title });
    },
    {
      name: 'read_task_notes',
      description:
        "Read this task's full Task File — its goal, previous tasks, notes, " +
        'outcome, and handoff so far.',
      schema: ReadTaskNotesSchema,
    },
  );
}
