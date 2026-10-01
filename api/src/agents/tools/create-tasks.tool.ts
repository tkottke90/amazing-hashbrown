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
import { getCronRegistry, type CronRegistry } from '../../services/cron-registry.js';
import { cronTiming, resolveCronConfig, type CronConfig } from '../../services/cron-config.js';
import { describeSchedule } from '../../services/cron-schedule.js';

const MAX_BATCH_SIZE = 20;

const TriggerSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('cron_once'),
      fireAt: z.string().describe('ISO 8601 date-time this task should run once, in the future.'),
      timezone: z
        .string()
        .optional()
        .describe(
          'IANA time zone, e.g. "America/Chicago". Defaults to the server-configured ' +
            'timezone if omitted.',
        ),
    }),
    z.object({
      type: z.literal('cron_repeat'),
      expression: z
        .string()
        .describe('Standard 5-field cron expression, e.g. "*/1 * * * *" for every minute.'),
      timezone: z.string().optional(),
      maxIterations: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe('Stop after this many fires. Omit or null for unlimited.'),
      stopAfter: z
        .string()
        .nullable()
        .optional()
        .describe('ISO 8601 date-time after which this schedule stops firing. Omit for no limit.'),
      maxConsecutiveFailures: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe('Auto-pause the schedule after this many runs fail in a row. Defaults to 3.'),
    }),
  ])
  .optional()
  .describe(
    'Omit for a plain one-shot task that runs immediately once queued (the default). Set this ' +
      'to give the task a recurring (cron_repeat) or future-dated (cron_once) schedule instead. ' +
      'Only describe this task as scheduled or recurring in your reply when this field was ' +
      "actually set and the tool's response confirms a schedule — otherwise it is a plain, " +
      'immediate task.',
  );

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
        dependsOnIndexes: z
          .array(z.number().int().nonnegative())
          .optional()
          .describe(
            'Zero-based indexes of other tasks in this SAME batch that must complete before ' +
              'this one starts (e.g. [0] means "wait for the first task in this list"). Must ' +
              'reference only earlier tasks in the list. A task with any dependency stays queued ' +
              '(not started, or unscheduled if it has a trigger) until they all finish ' +
              'successfully — use this instead of assuming tasks silently wait for each other.',
          ),
        trigger: TriggerSchema,
      }),
    )
    .describe('The batch of tasks to create, in the order they should run.'),
});

// Factory-injected store/registries (defaulting to the production
// singletons), matching create-project.tool.ts's testability pattern.
// Only bound in workspace-chat/task-agent builds (see buildWorkspaceScopedTools()
// in chat-agent.ts) — never in plain chat or sub-agent runs.
export function makeCreateTasksTool(
  store?: WorkspaceStore,
  trackerRegistry?: TrackerRegistry,
  cronRegistry?: CronRegistry,
) {
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

      // Resolve every task's trigger up front, via the same validation the
      // REST API uses (resolveCronConfig) — one bad schedule rejects the
      // whole batch before anything is inserted, same as the title check
      // above. A task with no `trigger` resolves to null here and keeps
      // today's plain 'chat' trigger type.
      const resolvedTriggers: (CronConfig | null)[] = [];
      for (let i = 0; i < tasks.length; i++) {
        const trigger = tasks[i]!.trigger;
        if (!trigger) {
          resolvedTriggers.push(null);
          continue;
        }
        const { type, ...fields } = trigger;
        const resolved = resolveCronConfig(type, null, fields, new Date());
        if (!resolved.ok) {
          return `Task ${i + 1}: ${resolved.error}. No tasks were created.`;
        }
        resolvedTriggers.push(resolved.config);
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
            trackerRegistry ?? getTrackerRegistry(),
            trackerUrl,
          );
          trackerType = resolved.type;
          trackerId = resolved.item.id;
        } catch (err) {
          return `Could not link tracker: ${(err as Error).message}. No tasks were created.`;
        }
      }

      const inputs: (NewTaskInput & { dependsOnIndexes?: number[] })[] = tasks.map((t, i) => ({
        workspaceId,
        title: t.title,
        description: t.description ?? null,
        outcome: t.outcome ?? null,
        plan: t.plan ? t.plan.map((step) => ({ step, done: false })) : null,
        dependsOnIndexes: t.dependsOnIndexes,
        assignedTo: 'agent',
        origin: 'user',
        triggerType: t.trigger?.type ?? 'chat',
        triggerConfig: resolvedTriggers[i] ?? undefined,
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
      if (resolvedTriggers.some((config) => config !== null)) {
        (cronRegistry ?? getCronRegistry()).resyncAll();
      }

      const now = new Date();
      return JSON.stringify({
        created: created.map((t, i) => {
          const config = resolvedTriggers[i];
          const triggerType = tasks[i]!.trigger?.type;
          if (!config || !triggerType) return { id: t.id, title: t.title };
          const { description, nextFireTimes } = describeSchedule(
            cronTiming(triggerType, config),
            now,
          );
          return {
            id: t.id,
            title: t.title,
            schedule: { description, nextFireAt: nextFireTimes[0]?.toISOString() ?? null },
          };
        }),
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
        "in each task's description. Tasks run in the order given, one at a time. Set a task's " +
        'trigger to give it a recurring or future-dated schedule instead of running it immediately.',
      schema: CreateTasksSchema,
    },
  );
}
