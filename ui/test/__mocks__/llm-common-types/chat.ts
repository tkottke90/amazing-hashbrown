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
