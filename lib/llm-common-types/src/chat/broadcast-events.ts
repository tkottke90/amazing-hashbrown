import { z } from 'zod';

// Out-of-band events pushed over the standing app-level SSE channel
// (GET /api/v1/events) — deliberately kept separate from ChatSSEEventSchema
// (sse-events.ts), which is turn-scoped (carries messageId/seq, opened only
// for the duration of one POSTed turn). These events have no turn, no
// message, and no ordering guarantee beyond "eventually delivered while
// connected" — a client reacts to them by patching local state or
// refetching from the existing REST endpoints, never by rendering the
// payload directly. See
// docs/superpowers/specs/2026-09-23-live-event-broadcast-design.md.

export const TaskQueueEntrySchema = z.object({
  id: z.string(),
  taskId: z.string(),
  status: z.enum(['pending', 'running', 'paused', 'done', 'failed', 'cancelled']),
  position: z.number(),
  enqueuedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  recoveryAttempts: z.number(),
  pauseReason: z.enum(['chat', 'user']).nullable(),
  pausedAt: z.string().nullable(),
});
export type TaskQueueEntry = z.infer<typeof TaskQueueEntrySchema>;

// `task` is loosely typed (no shared Task Zod schema exists in this package
// yet) rather than omitted — the frontend's QueueState type
// (ui/src/services/tasks-api.ts) requires every queue/running entry to carry
// its task record (nullable on `queue`, non-nullable on `running`, mirroring
// getQueueHandler's REST shape); leaving it out would silently blank the
// sidebar/Kanban queue widgets that already read `entry.task` directly the
// moment a broadcast replaced their last polled/fetched value.
const TaskQueueUpdateSchema = z.object({
  type: z.literal('task_queue_update'),
  queue: z.array(
    TaskQueueEntrySchema.extend({ task: z.record(z.string(), z.unknown()).nullable() }),
  ),
  running: z.array(TaskQueueEntrySchema.extend({ task: z.record(z.string(), z.unknown()) })),
});

const HitlPromptBroadcastSchema = z.object({
  type: z.literal('hitl_prompt'),
  threadId: z.string(),
  taskId: z.string(),
});

// Fired right after task-execution.ts durably writes the 'start'
// task_run_marker row — the only signal that a task has begun running,
// letting a client with that thread already open (global chat or a
// workspace Chat tab) hydrate it live instead of only on next reload. Not
// fired for the dependency-blocked pending -> blocked transition, which
// never reaches executeTask() at all.
const TaskStartedSchema = z.object({
  type: z.literal('task_started'),
  threadId: z.string(),
  taskId: z.string(),
});

const TaskCompletedSchema = z.object({
  type: z.literal('task_completed'),
  threadId: z.string(),
  taskId: z.string(),
  outcome: z.enum(['done', 'failed', 'cancelled']),
});

// Fired by the task agent's update_plan tool after it persists a plan
// change, carrying the whole updated plan so the Kanban board and an open
// Task Drawer can patch their copy without a refetch. Not fired for the
// human PATCH /tasks/:id path — the only viewer of that change is the
// drawer that made it. See
// docs/superpowers/specs/2026-09-25-task-plan-progress-design.md §5.
const TaskPlanUpdatedSchema = z.object({
  type: z.literal('task_plan_updated'),
  taskId: z.string(),
  plan: z.array(z.object({ step: z.string(), done: z.boolean() })),
});

export const AppBroadcastEventSchema = z.discriminatedUnion('type', [
  TaskQueueUpdateSchema,
  HitlPromptBroadcastSchema,
  TaskStartedSchema,
  TaskCompletedSchema,
  TaskPlanUpdatedSchema,
]);
export type AppBroadcastEvent = z.infer<typeof AppBroadcastEventSchema>;
