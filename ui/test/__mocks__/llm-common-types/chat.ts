import { z } from 'zod';

export const HitlKindSchema = z.enum(['yes_no', 'multiple_choice', 'free_text']);
export type HitlKind = z.infer<typeof HitlKindSchema>;

export const ChatSSEEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text_delta'), messageId: z.string(), delta: z.string() }),
  z.object({ type: z.literal('thought_delta'), messageId: z.string(), delta: z.string() }),
  z.object({
    type: z.literal('tool_call_start'),
    messageId: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    inputs: z.record(z.string(), z.unknown()),
  }),
  z.object({ type: z.literal('tool_call_end'), toolCallId: z.string(), outputs: z.unknown() }),
  z.object({
    type: z.literal('hitl_prompt'),
    messageId: z.string(),
    promptId: z.string(),
    question: z.string(),
    kind: HitlKindSchema,
    choices: z.array(z.string()).optional(),
    allowFreeText: z.boolean().optional(),
    approveLabel: z.string().optional(),
    approveType: z.enum(['primary', 'secondary', 'destructive']).optional(),
    rejectLabel: z.string().optional(),
  }),
  z.object({ type: z.literal('iframe_content'), messageId: z.string(), html: z.string() }),
  z.object({
    type: z.literal('audio_content'),
    messageId: z.string(),
    audioBase64: z.string(),
    mimeType: z.string(),
  }),
  z.object({ type: z.literal('stream_done'), durationMs: z.number() }),
  z.object({ type: z.literal('stream_error'), error: z.string() }),
  z.object({
    type: z.literal('usage_stats'),
    messageId: z.string(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    tokensPerSecond: z.number().optional(),
    contextWindowTokens: z.number().optional(),
    contextWindowLimit: z.number().nullable().optional(),
    contextUtilizationPct: z.number().optional(),
    estimatedCostUsd: z.number().optional(),
  }),
]);

export type ChatSSEEvent = z.infer<typeof ChatSSEEventSchema>;

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

export const AfterAgentStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('idle') }),
  z.object({ status: z.literal('running') }),
  z.object({
    status: z.literal('done'),
    outcome: z.enum(['identified', 'no-op', 'error']),
    finishedAt: z.string(),
  }),
]);
export type AfterAgentState = z.infer<typeof AfterAgentStateSchema>;

// Hand-duplicated from @tkottke90/amazing-hashbrown-widgets/types'
// DashboardWidgetSchema, same as every other schema in this mock — that
// package is ESM-only and can't be `require()`d by this CJS Jest mock as a
// runtime value (only type-only imports of it, erased at compile time, work
// elsewhere in this test suite).
const DashboardWidgetBaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  order: z.number(),
  w: z.number(),
  h: z.number(),
  source: z.enum(['manual', 'agent', 'system']),
  maintainer: z.string().optional(),
  updatedAt: z.string(),
});
const DashboardWidgetSchema = z.discriminatedUnion('type', [
  DashboardWidgetBaseSchema.extend({ type: z.literal('markdown'), content: z.string() }),
  DashboardWidgetBaseSchema.extend({
    type: z.literal('big-number'),
    value: z.number().optional(),
    unit: z.string().optional(),
  }),
  DashboardWidgetBaseSchema.extend({
    type: z.literal('line-graph'),
    data: z.string(),
    color: z.string().optional(),
  }),
  DashboardWidgetBaseSchema.extend({
    type: z.literal('pie-graph'),
    data: z.string(),
    colors: z.array(z.string()).optional(),
  }),
  DashboardWidgetBaseSchema.extend({ type: z.literal('spacer') }),
]);

export const AppBroadcastEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('task_queue_update'),
    queue: z.array(
      TaskQueueEntrySchema.extend({ task: z.record(z.string(), z.unknown()).nullable() }),
    ),
    running: z.array(TaskQueueEntrySchema.extend({ task: z.record(z.string(), z.unknown()) })),
  }),
  z.object({ type: z.literal('hitl_prompt'), threadId: z.string(), taskId: z.string() }),
  z.object({ type: z.literal('task_started'), threadId: z.string(), taskId: z.string() }),
  z.object({
    type: z.literal('task_completed'),
    threadId: z.string(),
    taskId: z.string(),
    outcome: z.enum(['done', 'failed', 'cancelled']),
  }),
  z.object({
    type: z.literal('task_plan_updated'),
    taskId: z.string(),
    plan: z.array(z.object({ step: z.string(), done: z.boolean() })),
  }),
  z.object({
    type: z.literal('thread_turn_started'),
    threadId: z.string(),
    source: z.enum(['wakeup', 'sub_agent']),
  }),
  z.object({ type: z.literal('thread_turn_completed'), threadId: z.string() }),
  z.object({
    type: z.literal('after_agent_state'),
    threadId: z.string(),
    state: AfterAgentStateSchema,
  }),
  z.object({
    type: z.literal('widget_updated'),
    dashboardId: z.string(),
    widget: DashboardWidgetSchema,
  }),
  z.object({
    type: z.literal('dashboard_reordered'),
    dashboardId: z.string(),
    widgets: z.array(DashboardWidgetSchema),
  }),
]);
export type AppBroadcastEvent = z.infer<typeof AppBroadcastEventSchema>;
