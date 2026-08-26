import { z } from 'zod';
import { HitlKindSchema } from './hitl.js';

// `seq` is the persisted display-order value from `thread_messages.seq` (see
// docs/Design/2026-07-18-persistent-conversation-memory-design.md). It is
// optional here because it is only known once the corresponding row has been
// written server-side — populated on the events emitted at/after that write,
// left undefined on purely transient events (e.g. streaming deltas).

const TextDeltaSchema = z.object({
  type: z.literal('text_delta'),
  messageId: z.string(),
  delta: z.string(),
});

const ThoughtDeltaSchema = z.object({
  type: z.literal('thought_delta'),
  messageId: z.string(),
  delta: z.string(),
});

const ToolCallStartSchema = z.object({
  type: z.literal('tool_call_start'),
  messageId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  inputs: z.record(z.string(), z.unknown()),
  seq: z.number().optional(),
});

const ToolCallEndSchema = z.object({
  type: z.literal('tool_call_end'),
  toolCallId: z.string(),
  outputs: z.unknown(),
});

const HitlPromptSchema = z.object({
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
  // Present when kind === 'shell_approval'
  command: z.string().optional(),
  reason: z.string().optional(),
  // The hitl_prompt row's own seq — not currently a fork target, but
  // populated for correctness/consistency with the DB truth.
  seq: z.number().optional(),
  // Same purpose as StreamDoneSchema's fields — a turn can end via either
  // event, and the assistant (and possibly user) message finalized just
  // before still needs its seq conveyed either way.
  assistantSeq: z.number().optional(),
  userSeq: z.number().optional(),
  // Present when kind === 'multiple_choice' and the prompt was triggered by
  // the recursion guard (recursion_limit_warning interrupt).
  stepsUsed: z.number().optional(),
  recursionLimit: z.number().optional(),
});

const IframeContentSchema = z.object({
  type: z.literal('iframe_content'),
  messageId: z.string(),
  html: z.string(),
  seq: z.number().optional(),
});

const AudioContentSchema = z.object({
  type: z.literal('audio_content'),
  messageId: z.string(),
  audioBase64: z.string(),
  mimeType: z.string(),
  seq: z.number().optional(),
});

const StreamDoneSchema = z.object({
  type: z.literal('stream_done'),
  durationMs: z.number(),
  // seq for the two messages this turn may have just created — carried on
  // the terminal event since neither user nor assistant messages otherwise
  // round-trip a seq during a live turn. Lets the UI's "fork from here"
  // action work immediately, without waiting for a reload to re-hydrate
  // seq from GET /threads/:id. assistantSeq is always present once a turn
  // completes successfully; userSeq only on the turn that created a new
  // user message (absent on HITL-resume/retry turns).
  assistantSeq: z.number().optional(),
  userSeq: z.number().optional(),
});

const StreamErrorSchema = z.object({
  type: z.literal('stream_error'),
  error: z.string(),
});

const WikiUpdatedSchema = z.object({
  type: z.literal('wiki_updated'),
  pageTitle: z.string(),
  pageKind: z.string(),
  wikiName: z.string(),
  seq: z.number().optional(),
});

const WikiOrientedSchema = z.object({
  type: z.literal('wiki_oriented'),
  wikiId: z.string(),
  wikiName: z.string(),
});

const WikiDomainCreatedSchema = z.object({
  type: z.literal('wiki_domain_created'),
  wikiId: z.string(),
});

const ResourceCreatedSchema = z.object({
  type: z.literal('resource_created'),
  resourceType: z.enum(['workspace', 'project']),
  name: z.string(),
  goal: z.string().optional(),
  location: z.string(),
  workspaceId: z.string(),
  seq: z.number().optional(),
});

const QueueStatusSchema = z.object({
  type: z.literal('queue_status'),
  paused: z.boolean(),
});

const SummarizingStartSchema = z.object({
  type: z.literal('summarizing_start'),
});

const SummarizingEndSchema = z.object({
  type: z.literal('summarizing_end'),
  // Present only when generation failed — absent on success.
  error: z.string().optional(),
});

const UsageStatsSchema = z.object({
  type: z.literal('usage_stats'),
  messageId: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  tokensPerSecond: z.number().optional(),
  contextWindowTokens: z.number().optional(),
  contextWindowLimit: z.number().nullable().optional(),
  contextUtilizationPct: z.number().optional(),
  estimatedCostUsd: z.number().optional(),
});

export const ChatSSEEventSchema = z.discriminatedUnion('type', [
  TextDeltaSchema,
  ThoughtDeltaSchema,
  ToolCallStartSchema,
  ToolCallEndSchema,
  HitlPromptSchema,
  IframeContentSchema,
  AudioContentSchema,
  StreamDoneSchema,
  StreamErrorSchema,
  WikiUpdatedSchema,
  WikiOrientedSchema,
  WikiDomainCreatedSchema,
  ResourceCreatedSchema,
  UsageStatsSchema,
  QueueStatusSchema,
  SummarizingStartSchema,
  SummarizingEndSchema,
]);

export type ChatSSEEvent = z.infer<typeof ChatSSEEventSchema>;
