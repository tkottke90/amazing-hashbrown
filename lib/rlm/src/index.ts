// Classes
export { RLMRunner } from './runner.js';
export { REPLEnvironment } from './repl.js';
export { ProvenanceStore } from './provenance.js';
export { NoOpEmbeddingAdapter } from './types.js';

// Utilities
export { formatTrace, deriveSourcesUsed, deriveMetrics } from './trace.js';

// Types from @tkottke90/inference-adapter (re-exported for consumers)
export type {
  Message,
  ToolCall,
  ToolResult,
  ToolDefinition,
  InferenceAdapter,
  InferenceResponse,
  BaseCompleteOptions,
  ExtendedCompleteOptions,
  EmbeddingAdapter,
} from './types.js';

// RLM-specific types
export type {
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
  ProvenanceEntry,
  CorpusMeta,
  SourceRange,
  IterationPhase,
  TraceDetail,
} from './types.js';

// Constants
export { DEFAULT_CONFIG } from './types.js';
