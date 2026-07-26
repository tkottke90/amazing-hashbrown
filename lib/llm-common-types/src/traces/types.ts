import { z } from 'zod';
import type { PaginationOptions } from '../db/types.js';

export const SpanTypeSchema = z.enum(['llm-call', 'tool-call']);

// Which subsystem opened this trace. Explicit rather than inferred from span
// names/content, so a trace is correctly attributable even when it has zero
// spans (e.g. a background pipeline that errors before its first LLM call —
// the exact case span-name inference cannot distinguish from a plain chat
// turn, since neither has recorded anything to infer from).
export const TraceSourceSchema = z.enum(['chat', 'after-agent', 'generate-title']);

export const SpanRecordSchema = z.object({
  spanId: z.string(),
  traceId: z.string(),
  // For tool-call spans: the spanId of the llm-call span that decided to invoke this tool.
  // For llm-call spans: null (they are roots within the trace).
  parentSpanId: z.string().nullable(),
  type: SpanTypeSchema,
  // For llm-call spans: the model name (e.g. "llama3.2", "claude-sonnet-4-6").
  // For tool-call spans: the tool name (e.g. "wiki_search", "upload_image").
  name: z.string(),
  startedAt: z.string(), // ISO 8601
  endedAt: z.string().nullable(),
  latencyMs: z.number().nullable(),
  // Token counts for llm-call spans; null for tool-call spans.
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  // For llm-call spans: JSON array of tool calls the model decided to make, or a preview
  //   of the response text if no tool calls were made.
  // For tool-call spans: a preview of the tool's return value (length controlled by
  //   observability.spanOutputPreviewChars in config.yaml).
  outputPreview: z.string().nullable(),
  // For llm-call spans: null. The message array sent to the model is stored in the
  //   LangGraph checkpoint and is not duplicated here.
  // For tool-call spans: the full JSON-serialized arguments passed to the tool.
  //   Tool arguments are always small (they are the model's decision artifact).
  inputPreview: z.string().nullable(),
  error: z.string().nullable(),
});

export const TraceRecordSchema = z.object({
  traceId: z.string(),
  // The conversation thread this trace belongs to.
  threadId: z.string().nullable(),
  // The autonomous task this trace belongs to (populated once the Task System exists).
  taskId: z.string().nullable(),
  provider: z.string(), // e.g. "local", "anthropic"
  model: z.string(), // e.g. "llama3.2", "claude-sonnet-4-6"
  source: TraceSourceSchema,
  startedAt: z.string(), // ISO 8601; satisfies BaseRecord.createdAt semantics
  endedAt: z.string().nullable(),
  totalTokens: z.number(),
  totalCostEstimate: z.number().nullable(), // in USD; populated by Usage & Cost Tracking (TODO #2)
  // The system/framing prompt in effect for this trace, captured once per
  // trace (not per span) to avoid duplication — see SpanRecordSchema's own
  // comment on why prompt content isn't stored per-span. Semantics vary by
  // source: for 'chat' it's the harness system prompt from buildSystemPrompt();
  // for 'generate-title' it's the whole input prompt (that source has no
  // separate system message — see threads.handlers.ts); for 'after-agent' it's
  // always null — that source runs multiple distinct prompts (summarize/
  // classify/extract/merge) within one trace, none of which is "a system
  // prompt" in this sense.
  systemPrompt: z.string().nullable(),
});

// TraceSummary — metrics only; no content fields.
// Use for conversation lists, dashboard widgets, and cost display.
// Avoids joining the spans table so it is fast even for large histories.
export const TraceSummarySchema = TraceRecordSchema.extend({
  spanCount: z.number(),
  llmCallCount: z.number(),
  toolCallCount: z.number(),
});

// TraceWithSpans — full trace detail including per-span content previews.
// Use for the evaluation harness, the trace detail view, and debugging.
export const TraceWithSpansSchema = TraceRecordSchema.extend({
  spans: z.array(SpanRecordSchema),
});

export type SpanType = z.infer<typeof SpanTypeSchema>;
export type TraceSource = z.infer<typeof TraceSourceSchema>;
export type SpanRecord = z.infer<typeof SpanRecordSchema>;
export type TraceRecord = z.infer<typeof TraceRecordSchema>;
export type TraceSummary = z.infer<typeof TraceSummarySchema>;
export type TraceWithSpans = z.infer<typeof TraceWithSpansSchema>;

// SpanNode — spans organized as a traversable tree.
// The root nodes are llm-call spans; their children are the tool-call spans
// that were triggered by that specific model call.
export type SpanNode = SpanRecord & { children: SpanNode[] };

// TraceFilters — query parameters accepted by ObservabilityStore.list().
// Extends PaginationOptions so all stores share the same pagination shape.
export interface TraceFilters extends PaginationOptions {
  threadId?: string;
  taskId?: string;
  // Returns only traces where startedAt >= since (ISO date string).
  since?: string;
}
