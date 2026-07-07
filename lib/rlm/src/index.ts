// Classes
export { RLMRunner } from "./runner.js";
export { REPLEnvironment } from "./repl.js";
export { ProvenanceStore } from "./provenance.js";
export { NoOpEmbeddingAdapter } from "./types.js";

// Utilities
export { formatTrace, deriveSourcesUsed, deriveMetrics } from "./trace.js";

// Types
export type {
  Role,
  Message,
  Tool,
  ToolCall,
  ModelResponse,
  RLMConfig,
  RLMResult,
  RLMCorpus,
  RLMTrace,
  RLMLogger,
  RLMMetrics,
  RLMEvent,
  RunStartedEvent,
  IterationStartedEvent,
  ModelRequestedEvent,
  ModelRespondedEvent,
  ToolDispatchedEvent,
  ToolCompletedEvent,
  LoopDetectionEvent,
  SynthesisTriggeredEvent,
  SynthesisCompletedEvent,
  RunCompletedEvent,
  TerminationReason,
  ToolCallRecord,
  StatusSignal,
  StatusCallback,
  ModelAdapter,
  RlmEmbeddingAdapter,
  ProvenanceEntry,
  CorpusMeta,
  SourceRange,
  IterationPhase,
  TraceDetail,
} from "./types.js";

// Constants
export { DEFAULT_CONFIG } from "./types.js";
