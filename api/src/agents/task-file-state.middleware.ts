import { createMiddleware } from 'langchain';
import { z } from 'zod';
import { TaskStateSchema, cloneEmptyTaskState } from '../services/task-file.js';

// Schema-only middleware, no hooks of its own — it exists purely so
// `taskState` is part of the graph's own checkpointed state, readable and
// writable by write_task_note/update_plan (which return a Command updating
// it directly from their own tool body — see
// docs/superpowers/specs/2026-10-21-workspace-task-files-design.md §4) and
// readable back by task-execution.ts after a run ends (agent.graph.getState).
// Bound only in buildTaskAgent — a Task File only exists for a
// workspace-scoped, non-Sub-Agent-Task run.
//
// `.default(cloneEmptyTaskState)` — a factory function, not a plain object
// — so every agent invocation that needs the default gets its OWN fresh
// object/arrays. A plain-object default would shallow-clone only the top
// level on each parse, leaving `notes` (and every other array/object
// field) shared by reference across every invocation that defaults it —
// confirmed the hard way (one agent's write_task_note mutating a different
// test's/run's "empty" state).
export const taskFileStateSchema = z.object({
  taskState: TaskStateSchema.default(cloneEmptyTaskState),
});

export function createTaskFileStateMiddleware() {
  return createMiddleware({
    name: 'TaskFileStateMiddleware',
    stateSchema: taskFileStateSchema,
  });
}
