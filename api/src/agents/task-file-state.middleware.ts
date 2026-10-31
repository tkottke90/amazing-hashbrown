import { createMiddleware } from 'langchain';
import { withLangGraph } from '@langchain/langgraph/zod';
import { z } from 'zod';
import {
  TaskStateSchema,
  cloneEmptyTaskState,
  writeTaskFile,
  type TaskState,
} from '../services/task-file.js';
import { getWorkspaceStore, type WorkspaceStore } from '../services/workspace-store.js';
import { logger, serializeError } from '../config/logger.js';
import type { UpdatePlanTaskFile } from './tools/update-plan.tool.js';

// Write-side shapes the taskState channel accepts. write_task_note/
// update_plan send the append delta — both only ever append to the current
// run's last notes segment, never touch goal/previousTasks/outcome/handoff
// (ADR-0047). task-execution.ts separately seeds a *full* TaskState as part
// of the top-level agent.invoke() input at the very start of a fresh run
// (before any node has run, never concurrent with a tool call) — that seed
// goes through this same channel update path too, so the reducer has to
// accept both shapes.
export const TaskStateAppendSchema = z.object({
  appendNotes: z.array(z.string()),
});
export const TaskStateUpdateSchema = z.union([TaskStateSchema, TaskStateAppendSchema]);

// The taskState channel's reducer. @langchain/langgraph's
// BinaryOperatorAggregate folds this sequentially against the real
// persisted value for every concurrent write in a step (current =
// fn(current, writeA); current = fn(current, writeB); ...), so this never
// needs to diff against a stale base — `current` is always authoritative.
// A full TaskState (task-execution.ts's run-start seed) replaces wholesale,
// since it's never concurrent with anything. An append delta returns the
// SAME object reference when appendNotes is empty, which is what makes the
// reference-equality dirty check in createTaskFileStateMiddleware's hooks
// correct.
export function mergeTaskState(
  current: TaskState,
  delta: z.infer<typeof TaskStateUpdateSchema>,
): TaskState {
  if (!('appendNotes' in delta)) return delta;
  if (delta.appendNotes.length === 0) return current;
  const notes = current.notes.length > 0 ? current.notes : [[]];
  const lastSegment = notes[notes.length - 1] ?? [];
  return {
    ...current,
    notes: [...notes.slice(0, -1), [...lastSegment, ...delta.appendNotes]],
  };
}

// `.default(cloneEmptyTaskState)` — a factory function, not a plain object
// — so every agent invocation that needs the default gets its OWN fresh
// object/arrays. A plain-object default would shallow-clone only the top
// level on each parse, leaving `notes` (and every other array/object
// field) shared by reference across every invocation that defaults it —
// confirmed the hard way (one agent's write_task_note mutating a different
// test's/run's "empty" state).
export const taskFileStateSchema = z.object({
  taskState: withLangGraph(TaskStateSchema.default(cloneEmptyTaskState), {
    reducer: { schema: TaskStateUpdateSchema, fn: mergeTaskState },
    default: cloneEmptyTaskState,
  }),
});

// Also owns Task File persistence (ADR-0047) — write_task_note/update_plan
// used to write the file inline from their own tool body, but both only
// ever saw the pre-step taskState snapshot, so two of them writing in the
// same step raced on disk independent of (and not fixed by) the graph
// channel's reducer above. Persisting once per step, after the channel has
// actually been reduced, is only reachable from beforeModel (fires after
// the prior step's tool-node reduction has committed) + afterAgent (fires
// once at the very end, covering a return_direct tool that skips the
// loop-back to beforeModel) — no single createMiddleware hook sees
// post-reduction state within the same step.
//
// `taskId`/`taskFile` are optional because buildChatAgent and
// buildWorkspaceChatAgent also bind this middleware unconditionally (purely
// to keep their ChatAgent tuple type in lockstep with buildTaskAgent's), and
// have no task in scope at all — `persistIfDirty` below no-ops whenever
// either is missing, so those call sites stay the harmless no-op they
// already were before this middleware gained hooks.
export function createTaskFileStateMiddleware(
  taskId?: string,
  taskFile?: UpdatePlanTaskFile,
  store?: WorkspaceStore,
  persist: typeof writeTaskFile = writeTaskFile,
) {
  // Closure-scoped, built fresh per task run (same per-construction-factory
  // pattern as makeUpdatePlanTool). undefined means "haven't observed this
  // run's state yet" — deliberately distinct from the channel's own
  // default value (a separately-constructed, reference-unequal object),
  // so the very first observation only establishes a baseline instead of
  // always looking dirty. That first observation is either the bare empty
  // default (nothing worth persisting yet) or task-execution.ts's own
  // run-start seed (already written to disk by the orchestrator moments
  // earlier) — either way, nothing new to persist until a later observation
  // actually differs from it.
  let lastPersisted: TaskState | undefined;

  async function persistIfDirty(state: { taskState: TaskState }) {
    if (!taskFile || !taskId) return;
    if (lastPersisted === undefined) {
      lastPersisted = state.taskState;
      return;
    }
    if (state.taskState === lastPersisted) return;
    const s = store ?? getWorkspaceStore();
    const title = s.getTask(taskId)?.title ?? taskId;
    try {
      await persist(taskFile.filePath, state.taskState, { taskId, title });
      lastPersisted = state.taskState;
    } catch (err) {
      // I/O failure must never fail the run — the agent's note is still
      // reflected in graph state even if the on-disk mirror lags.
      logger.warn('task-file-state: failed to write Task File', {
        taskId,
        filePath: taskFile.filePath,
        err: serializeError(err),
      });
    }
  }

  return createMiddleware({
    name: 'TaskFileStateMiddleware',
    stateSchema: taskFileStateSchema,
    beforeModel: async (state) => {
      await persistIfDirty(state);
      return undefined;
    },
    afterAgent: async (state) => {
      await persistIfDirty(state);
      return undefined;
    },
  });
}
