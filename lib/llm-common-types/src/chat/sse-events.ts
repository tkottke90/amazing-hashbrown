import { z } from 'zod';
import { HitlKindSchema } from './hitl.js';

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
});

const IframeContentSchema = z.object({
  type: z.literal('iframe_content'),
  messageId: z.string(),
  html: z.string(),
});

const AudioContentSchema = z.object({
  type: z.literal('audio_content'),
  messageId: z.string(),
  audioBase64: z.string(),
  mimeType: z.string(),
});

const StreamDoneSchema = z.object({
  type: z.literal('stream_done'),
  durationMs: z.number(),
});

const StreamErrorSchema = z.object({
  type: z.literal('stream_error'),
  error: z.string(),
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
]);

export type ChatSSEEvent = z.infer<typeof ChatSSEEventSchema>;
