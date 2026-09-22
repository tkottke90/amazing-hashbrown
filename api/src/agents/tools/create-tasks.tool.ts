import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import { logger, serializeError } from '../../config/logger.js';
import {
  getWorkspaceStore,
  type WorkspaceStore,
  type NewTaskInput,
} from '../../services/workspace-store.js';
import { getTaskScheduler } from '../../services/task-scheduler.js';
import {
  getTrackerRegistry,
  resolveTrackerUrlAnyAdapter,
  type TrackerRegistry,
} from '../../services/tracker-registry.js';

const MAX_BATCH_SIZE = 20;

const CreateTasksSchema = z.object({
  trackerUrl: z
    .string()
    .optional()
    .describe(
      'A GitHub issue/PR URL (or other registered tracker URL) to link every task in this batch to.',
    ),
  tasks: z
    .array(
      z.object({
        title: z.string().describe('Short task title.'),
        description: z.string().optional().describe('What this task should accomplish.'),
        outcome: z.string().optional().describe('What "done" looks like for this task.'),
        plan: z
          .array(z.string())
          .optional()
          .describe("Fine-grained checklist steps for this task's own run."),
      }),
    )
    .describe('The batch of tasks to create, in the order they should run.'),
});

// Factory-injected store/registry (defaulting to the production
// singletons), matching create-project.tool.ts's testability pattern.
// Only bound in workspace-chat/task-agent builds (see buildWorkspaceScopedTools()
// in chat-agent.ts) — never in plain chat or sub-agent runs.
export function makeCreateTasksTool(store?: WorkspaceStore, registry?: TrackerRegistry) {
  return tool(
    async ({ trackerUrl, tasks }: z.infer<typeof CreateTasksSchema>, runtime: ToolRuntime) => {
      const workspaceId = runtime.configurable?.workspaceId as string | undefined;
      if (!workspaceId) {
        return 'Cannot create tasks: no active workspace.';
      }

      if (tasks.length === 0) {
        return 'At least one task is required.';
      }
      if (tasks.length > MAX_BATCH_SIZE) {
        return `Too many tasks in one batch (${tasks.length}); the limit is ${MAX_BATCH_SIZE}.`;
      }
      for (let i = 0; i < tasks.length; i++) {
        if (!tasks[i]!.title || !tasks[i]!.title.trim()) {
          return `Task ${i + 1} has no title; no tasks were created.`;
        }
      }

      const s = store ?? getWorkspaceStore();
      if (!s.getWorkspace(workspaceId)) {
        return 'Workspace no longer exists; no tasks were created.';
      }

      let trackerType: string | undefined;
      let trackerId: string | undefined;
      if (trackerUrl) {
        try {
          const resolved = await resolveTrackerUrlAnyAdapter(
            registry ?? getTrackerRegistry(),
            trackerUrl,
          );
          trackerType = resolved.type;
          trackerId = resolved.item.id;
        } catch (err) {
          return `Could not link tracker: ${(err as Error).message}. No tasks were created.`;
        }
      }

      const inputs: NewTaskInput[] = tasks.map((t) => ({
        workspaceId,
        title: t.title,
        description: t.description ?? null,
        outcome: t.outcome ?? null,
        plan: t.plan ? t.plan.map((step) => ({ step, done: false })) : null,
        assignedTo: 'agent',
        origin: 'user',
        triggerType: 'chat',
        trackerType: trackerType ?? null,
        trackerId: trackerId ?? null,
      }));

      let created;
      try {
        created = s.createTasks(inputs);
      } catch (err) {
        logger.error('create_tasks: batch insert failed', { err: serializeError(err) });
        return `Failed to create tasks: ${(err as Error).message}`;
      }

      getTaskScheduler().wake();

      return JSON.stringify({
        created: created.map((t) => ({ id: t.id, title: t.title })),
        ...(trackerType ? { tracker: { type: trackerType, id: trackerId } } : {}),
      });
    },
    {
      name: 'create_tasks',
      description:
        'Create a batch of queued tasks that will run autonomously, one after another, in this ' +
        'workspace — use this once a plan has been discussed and approved (e.g. after breaking ' +
        'down an approved GitHub issue), not while still brainstorming. Optionally link the whole ' +
        'batch to a tracker URL (e.g. a GitHub issue/PR) via trackerUrl instead of re-describing it ' +
        "in each task's description. Tasks run in the order given, one at a time.",
      schema: CreateTasksSchema,
    },
  );
}
