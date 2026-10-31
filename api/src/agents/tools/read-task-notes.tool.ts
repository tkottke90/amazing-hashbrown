import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { getWorkspaceStore, type WorkspaceStore } from '../../services/workspace-store.js';
import { cloneEmptyTaskState, renderTaskStateToMarkdown } from '../../services/task-file.js';
import { taskFileStateSchema } from '../task-file-state.middleware.js';

const ReadTaskNotesSchema = z.object({});

// Built fresh per automated task run, closed over that task's id. Returns
// the current rendered Task File content straight from in-memory graph
// state, never the disk — TaskFileStateMiddleware's beforeModel/afterAgent
// hooks (ADR-0047) keep the on-disk file caught up to this same graph
// state once per step, so the two only ever lag by at most one step, never
// diverge. Bound only in buildTaskAgent, alwaysOn in the tool catalog —
// never in interactive chat, workspace chat, or sub-agent runs.
export function makeReadTaskNotesTool(taskId: string, store?: WorkspaceStore) {
  return tool(
    async (
      _args: z.infer<typeof ReadTaskNotesSchema>,
      runtime: ToolRuntime<typeof taskFileStateSchema>,
    ) => {
      const s = store ?? getWorkspaceStore();
      const task = s.getTask(taskId);
      const title = task?.title ?? taskId;
      // The channel's own default factory always supplies a value before
      // this tool ever runs — `?? cloneEmptyTaskState()` only satisfies the
      // type checker (see taskFileStateSchema's `.optional()` comment).
      const taskState = runtime.state.taskState ?? cloneEmptyTaskState();
      return renderTaskStateToMarkdown(taskState, { taskId, title });
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
