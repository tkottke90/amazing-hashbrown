export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolName?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ModelResponse {
  content: string;
  rawContent: string; // content before any post-processing (think-block stripping, etc.)
  toolCalls: ToolCall[];
  durationMs: number;
}

export interface ModelAdapter {
  complete(
    messages: Message[],
    tools: Tool[],
    config: RLMConfig
  ): Promise<ModelResponse>;
}

// "full"    → model_requested events include the complete messages array
// "compact" → model_requested events include message counts only (no content)
// "minimal" → events carry only structural metadata; no content fields
export type TraceDetail = "full" | "compact" | "minimal";

export interface RLMConfig {
  model: string;
  maxIterations: number;
  maxResultTokens: number;
  maxSliceLines: number;
  think?: boolean;
  promptAddendum?: string;
  extraTools?: Tool[];
  traceDetail?: TraceDetail;
}

export const DEFAULT_CONFIG: RLMConfig = {
  model: "qwen3:8b",
  maxIterations: 10,
  maxResultTokens: 2000,
  maxSliceLines: 200,
  think: false,
  traceDetail: "full",
};

export type TerminationReason =
  | "final_tool"
  | "not_found_tool"
  | "no_tool_call"
  | "max_iterations";

// The phase label derived from which tool the model called in an iteration.
// Used on ToolDispatchedEvent and on StatusSignal.
export type IterationPhase =
  | "orientation" // peek
  | "searching"   // grep, search
  | "reading"     // slice, get_provenance
  | "summarizing" // summarize
  | "querying"    // query
  | "answering"   // final_answer, no_tool_call
  | "not_found";  // not_found

export interface ToolCallRecord {
  iteration: number;
  tool: string;
  args: Record<string, unknown>;
  resultPreview: string;
  durationMs: number;
}

// Metadata about the corpus — serializable snapshot, no reference to the live object.
export interface CorpusMeta {
  source?: string;
  charCount: number;
  lineCount: number;
  hasEmbeddings: boolean;
  hasProvenance: boolean;
}

// A specific line range that was read during the run, used for source attribution.
export interface SourceRange {
  tool: "slice" | "summarize" | "query" | "peek";
  startLine: number;
  endLine: number;
  iteration: number;
}

export interface RLMMetrics {
  modelCallCount: number;
  totalModelDurationMs: number;
  totalToolDurationMs: number;
  charsRead: number;
  coverageRatio: number;    // charsRead / corpusMeta.charCount
  peekFirst: boolean;       // was peek the first retrieval tool called?
  synthesisTriggered: boolean;
  toolFrequency: Record<string, number>;
}

// --------------------------------------------------------------------------
// Trace event types — discriminated union on `kind`.
//
// Matched pairs (model_requested/model_responded, tool_dispatched/tool_completed,
// synthesis_triggered/synthesis_completed) share a `correlationId` so a UI can
// link the start and end of each operation without scanning the full event list.
// --------------------------------------------------------------------------

interface RLMEventBase {
  eventId: string;
  timestampMs: number;
}

export interface RunStartedEvent extends RLMEventBase {
  kind: "run_started";
  query: string;
  corpusMeta: CorpusMeta;
}

export interface IterationStartedEvent extends RLMEventBase {
  kind: "iteration_started";
  iteration: number;
}

export interface ModelRequestedEvent extends RLMEventBase {
  kind: "model_requested";
  correlationId: string;
  iteration: number;
  messageCount: number;
  messages?: Message[]; // present only when traceDetail === "full"
}

export interface ModelRespondedEvent extends RLMEventBase {
  kind: "model_responded";
  correlationId: string;
  iteration: number;
  durationMs: number;
  content: string;      // post-processing (think blocks stripped)
  rawContent: string;   // verbatim from the wire; present when traceDetail !== "minimal"
  toolCalls: ToolCall[];
}

export interface ToolDispatchedEvent extends RLMEventBase {
  kind: "tool_dispatched";
  correlationId: string;
  iteration: number;
  tool: string;
  args: Record<string, unknown>;
  phase: IterationPhase;
  displayMessage: string; // the user-facing status message for this tool call
}

export interface ToolCompletedEvent extends RLMEventBase {
  kind: "tool_completed";
  correlationId: string;
  iteration: number;
  tool: string;
  durationMs: number;
  result: string; // full result when traceDetail === "full"; truncated otherwise
}

export interface LoopDetectionEvent extends RLMEventBase {
  kind: "loop_detection";
  iteration: number;
  tool: string;
  args: Record<string, unknown>;
  iterationsDeducted: number;
}

export interface SynthesisTriggeredEvent extends RLMEventBase {
  kind: "synthesis_triggered";
  correlationId: string;
}

export interface SynthesisCompletedEvent extends RLMEventBase {
  kind: "synthesis_completed";
  correlationId: string;
  durationMs: number;
  content: string;
  hadToolCallEscape: boolean; // model emitted tool-call syntax despite tools being suppressed
}

export interface RunCompletedEvent extends RLMEventBase {
  kind: "run_completed";
  durationMs: number;
  terminationReason: TerminationReason;
  found: boolean;
  iterations: number;
}

export type RLMEvent =
  | RunStartedEvent
  | IterationStartedEvent
  | ModelRequestedEvent
  | ModelRespondedEvent
  | ToolDispatchedEvent
  | ToolCompletedEvent
  | LoopDetectionEvent
  | SynthesisTriggeredEvent
  | SynthesisCompletedEvent
  | RunCompletedEvent;

// --------------------------------------------------------------------------

export interface RLMResult {
  answer: string;
  found: boolean;
  iterations: number;
  toolCallTrace: ToolCallRecord[];
  terminationReason: TerminationReason;
  loopDetectionFired: boolean;
  totalDurationMs: number;
  events: RLMEvent[];
  metrics: RLMMetrics;
  sourcesUsed: SourceRange[];
}

// Self-contained audit record emitted to RLMLogger.onTrace at run completion.
// Includes everything needed to understand, replay, or render the run without
// any external context.
export interface RLMTrace {
  traceId: string;
  startedAt: string;   // ISO 8601
  completedAt: string; // ISO 8601
  query: string;
  corpusMeta: CorpusMeta;
  config: RLMConfig;
  systemPrompt: string;
  events: RLMEvent[];
  result: RLMResult;
}

// Observability interface — implement to route events to any sink (console,
// database, OpenTelemetry, Langfuse, etc.). Both methods are optional so
// callers can implement only what they need.
export interface RLMLogger {
  onEvent?(event: RLMEvent): void;
  onTrace?(trace: RLMTrace): void;
}

// --------------------------------------------------------------------------

export interface StatusSignal {
  phase: IterationPhase;
  message: string;
  iteration: number;
  tool?: string;
}

export type StatusCallback = (signal: StatusSignal) => void;

export interface RlmEmbeddingAdapter {
  embed(texts: string[]): Promise<number[][]>;
}

export class NoOpEmbeddingAdapter implements RlmEmbeddingAdapter {
  async embed(_texts: string[]): Promise<number[][]> {
    return [];
  }
}

export interface ProvenanceEntry {
  entityId: string;
  claimText: string;
  sourceDocId: string;
  sourceType: string;
  writtenAt: string;
  supersededBy?: string;
}

export interface RLMCorpus {
  text: string;
  source?: string;
  provenance?: import("./provenance.js").ProvenanceStore;
}
