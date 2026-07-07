import type {
  RLMEvent,
  RLMTrace,
  RLMLogger,
  RLMResult,
  RLMConfig,
  RLMMetrics,
  SourceRange,
  CorpusMeta,
  IterationPhase,
  Message,
  ToolCall,
  ModelResponse,
  TerminationReason,
  TraceDetail,
  ToolDispatchedEvent,
  ToolCompletedEvent,
} from './types.js';

// --------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------

function newEventId(): string {
  return crypto.randomUUID();
}

function now(): number {
  return Date.now();
}

const RESULT_PREVIEW_CHARS = 200;
const FORMAT_RESULT_PREVIEW_CHARS = 120;

// --------------------------------------------------------------------------
// TraceBuilder — accumulates events during a run; used internally by runner.
// --------------------------------------------------------------------------

export class TraceBuilder {
  private readonly events: RLMEvent[] = [];
  private readonly detail: TraceDetail;
  private readonly logger: RLMLogger | undefined;

  constructor(detail: TraceDetail, logger?: RLMLogger) {
    this.detail = detail;
    this.logger = logger;
  }

  private emit<T extends RLMEvent>(event: T): T {
    this.events.push(event);
    this.logger?.onEvent?.(event);
    return event;
  }

  getEvents(): RLMEvent[] {
    return [...this.events];
  }

  // -- Event emitters -------------------------------------------------------

  runStarted(query: string, corpusMeta: CorpusMeta): void {
    this.emit({
      kind: 'run_started',
      eventId: newEventId(),
      timestampMs: now(),
      query,
      corpusMeta,
    });
  }

  iterationStarted(iteration: number): void {
    this.emit({ kind: 'iteration_started', eventId: newEventId(), timestampMs: now(), iteration });
  }

  // Returns the correlationId so the caller can link the corresponding responded event.
  modelRequested(iteration: number, messages: Message[]): string {
    const correlationId = newEventId();
    this.emit({
      kind: 'model_requested',
      eventId: newEventId(),
      timestampMs: now(),
      correlationId,
      iteration,
      messageCount: messages.length,
      messages: this.detail === 'full' ? messages : undefined,
    });
    return correlationId;
  }

  modelResponded(
    correlationId: string,
    iteration: number,
    response: ModelResponse,
    durationMs: number,
  ): void {
    this.emit({
      kind: 'model_responded',
      eventId: newEventId(),
      timestampMs: now(),
      correlationId,
      iteration,
      durationMs,
      content: response.content,
      rawContent: this.detail !== 'minimal' ? response.rawContent : '',
      toolCalls: response.toolCalls,
    });
  }

  // Returns the correlationId so the caller can link the corresponding completed event.
  toolDispatched(
    iteration: number,
    toolCall: ToolCall,
    phase: IterationPhase,
    displayMessage: string,
  ): string {
    const correlationId = newEventId();
    this.emit({
      kind: 'tool_dispatched',
      eventId: newEventId(),
      timestampMs: now(),
      correlationId,
      iteration,
      tool: toolCall.name,
      args: toolCall.args,
      phase,
      displayMessage,
    });
    return correlationId;
  }

  toolCompleted(
    correlationId: string,
    iteration: number,
    tool: string,
    result: string,
    durationMs: number,
  ): void {
    const resultContent =
      this.detail === 'full'
        ? result
        : this.detail === 'compact'
          ? result.slice(0, RESULT_PREVIEW_CHARS)
          : '';

    this.emit({
      kind: 'tool_completed',
      eventId: newEventId(),
      timestampMs: now(),
      correlationId,
      iteration,
      tool,
      durationMs,
      result: resultContent,
    });
  }

  loopDetection(iteration: number, toolCall: ToolCall, iterationsDeducted: number): void {
    this.emit({
      kind: 'loop_detection',
      eventId: newEventId(),
      timestampMs: now(),
      iteration,
      tool: toolCall.name,
      args: toolCall.args,
      iterationsDeducted,
    });
  }

  // Returns correlationId for the paired synthesis_completed event.
  synthesisTriggered(): string {
    const correlationId = newEventId();
    this.emit({
      kind: 'synthesis_triggered',
      eventId: newEventId(),
      timestampMs: now(),
      correlationId,
    });
    return correlationId;
  }

  synthesisCompleted(
    correlationId: string,
    content: string,
    hadToolCallEscape: boolean,
    durationMs: number,
  ): void {
    this.emit({
      kind: 'synthesis_completed',
      eventId: newEventId(),
      timestampMs: now(),
      correlationId,
      durationMs,
      content,
      hadToolCallEscape,
    });
  }

  runCompleted(
    terminationReason: TerminationReason,
    found: boolean,
    iterations: number,
    totalDurationMs: number,
  ): void {
    this.emit({
      kind: 'run_completed',
      eventId: newEventId(),
      timestampMs: now(),
      durationMs: totalDurationMs,
      terminationReason,
      found,
      iterations,
    });
  }

  buildTrace(
    query: string,
    corpusMeta: CorpusMeta,
    config: RLMConfig,
    systemPrompt: string,
    result: RLMResult,
    startMs: number,
  ): RLMTrace {
    return {
      traceId: newEventId(),
      startedAt: new Date(startMs).toISOString(),
      completedAt: new Date().toISOString(),
      query,
      corpusMeta,
      config,
      systemPrompt,
      events: this.getEvents(),
      result,
    };
  }
}

// --------------------------------------------------------------------------
// Derived fields — computed from the event stream at run completion.
// --------------------------------------------------------------------------

export function deriveSourcesUsed(events: RLMEvent[]): SourceRange[] {
  const sources: SourceRange[] = [];

  // Index tool_dispatched events by correlationId to cross-reference args.
  const dispatched = new Map<string, ToolDispatchedEvent>();
  for (const e of events) {
    if (e.kind === 'tool_dispatched') dispatched.set(e.correlationId, e);
  }

  for (const e of events) {
    if (e.kind !== 'tool_completed') continue;
    const dispatch = dispatched.get((e as ToolCompletedEvent).correlationId);
    if (!dispatch) continue;

    const { tool, args, iteration } = dispatch;

    if (tool === 'slice' || tool === 'summarize' || tool === 'query') {
      const startLine = Number(args['startLine'] ?? 1);
      const endLine = Number(args['endLine'] ?? startLine);
      if (!isNaN(startLine) && !isNaN(endLine)) {
        sources.push({ tool: tool as SourceRange['tool'], startLine, endLine, iteration });
      }
    } else if (tool === 'peek') {
      // Approximate line range: peek always starts at line 1; end is estimated
      // from char count against average line length (computed from corpusMeta
      // at call site — we use a conservative 60 chars/line fallback here).
      const chars = Number(args['chars'] ?? 2000);
      const estimatedEnd = Math.max(1, Math.ceil(chars / 60));
      sources.push({ tool: 'peek', startLine: 1, endLine: estimatedEnd, iteration });
    }
  }

  return sources;
}

export function deriveMetrics(events: RLMEvent[], corpusMeta: CorpusMeta): RLMMetrics {
  let modelCallCount = 0;
  let totalModelDurationMs = 0;
  let totalToolDurationMs = 0;
  let charsRead = 0;
  let synthesisTriggered = false;
  const toolFrequency: Record<string, number> = {};

  let firstRetrievalTool: string | null = null;

  for (const e of events) {
    if (e.kind === 'model_responded') {
      modelCallCount++;
      totalModelDurationMs += e.durationMs;
    }

    if (e.kind === 'synthesis_triggered') {
      synthesisTriggered = true;
    }

    if (e.kind === 'tool_dispatched') {
      const tool = e.tool;
      // Only count retrieval tools (not terminal tools) for frequency and firstTool
      if (tool !== 'final_answer' && tool !== 'not_found') {
        toolFrequency[tool] = (toolFrequency[tool] ?? 0) + 1;
        if (firstRetrievalTool === null) firstRetrievalTool = tool;
      }
    }

    if (e.kind === 'tool_completed') {
      totalToolDurationMs += e.durationMs;
      // Estimate chars read from the result length for slice/peek/summarize/query
      const dispatched = events.find(
        (d): d is ToolDispatchedEvent =>
          d.kind === 'tool_dispatched' && d.correlationId === e.correlationId,
      );
      if (dispatched && ['slice', 'peek', 'summarize', 'query'].includes(dispatched.tool)) {
        charsRead += e.result.length;
      }
    }
  }

  const coverageRatio =
    corpusMeta.charCount > 0 ? Math.min(1, charsRead / corpusMeta.charCount) : 0;

  return {
    modelCallCount,
    totalModelDurationMs,
    totalToolDurationMs,
    charsRead,
    coverageRatio,
    peekFirst: firstRetrievalTool === 'peek',
    synthesisTriggered,
    toolFrequency,
  };
}

// --------------------------------------------------------------------------
// formatTrace — human-readable text representation of a completed trace.
// Suitable for console output, log files, or a <pre> block in a UI.
// --------------------------------------------------------------------------

const RULE = '━'.repeat(56);
const THIN_RULE = '─'.repeat(56);

const PHASE_LABELS: Record<string, string> = {
  orientation: 'Orientation',
  searching: 'Searching',
  reading: 'Reading',
  summarizing: 'Summarizing',
  querying: 'Querying',
  answering: 'Answer',
  not_found: 'Not Found',
};

export function formatTrace(trace: RLMTrace): string {
  const { result, corpusMeta, config } = trace;
  const lines: string[] = [];

  // Header
  lines.push(RULE);
  lines.push(`RLM Trace  ${trace.traceId}`);
  lines.push(
    `${trace.startedAt}  →  ${trace.completedAt}  (${result.totalDurationMs.toLocaleString()}ms)`,
  );
  lines.push(RULE);
  lines.push(`Query:   ${JSON.stringify(trace.query)}`);
  const sourceLabel = corpusMeta.source ? `${corpusMeta.source}  ` : '';
  lines.push(
    `Corpus:  ${sourceLabel}(${corpusMeta.charCount.toLocaleString()} chars / ${corpusMeta.lineCount.toLocaleString()} lines)`,
  );
  lines.push(
    `Model:   ${config.model}   Iterations: ${result.iterations}/${config.maxIterations}   Terminated: ${result.terminationReason}`,
  );
  if (result.loopDetectionFired) lines.push(`         ⚠ loop detection fired`);
  lines.push(RULE);
  lines.push('');

  // Group events by iteration
  const iterationGroups = groupByIteration(trace.events);

  // Index dispatched events by correlationId for lookup
  const dispatchedByCorrelation = new Map<string, ToolDispatchedEvent>();
  const completedByCorrelation = new Map<string, ToolCompletedEvent>();
  for (const e of trace.events) {
    if (e.kind === 'tool_dispatched') dispatchedByCorrelation.set(e.correlationId, e);
    if (e.kind === 'tool_completed') completedByCorrelation.set(e.correlationId, e);
  }

  for (const [iteration, group] of iterationGroups) {
    const modelResp = group.find((e) => e.kind === 'model_responded');
    const toolDisp = group.find((e) => e.kind === 'tool_dispatched') as
      ToolDispatchedEvent | undefined;
    const toolComp = toolDisp ? completedByCorrelation.get(toolDisp.correlationId) : undefined;
    const loopDet = group.find((e) => e.kind === 'loop_detection');

    const modelMs = modelResp?.kind === 'model_responded' ? modelResp.durationMs : 0;
    const phaseLabel = toolDisp ? (PHASE_LABELS[toolDisp.phase] ?? toolDisp.phase) : '—';

    const loopFlag = loopDet ? '  ⚠ loop-detection' : '';
    const header = `[${iteration}] ${phaseLabel}${loopFlag}`;
    const modelSuffix = modelMs > 0 ? `${modelMs}ms model` : '';
    const headerLine = padBetween(header, modelSuffix, 56);
    lines.push(headerLine);

    if (toolDisp) {
      const argsStr = formatArgs(toolDisp.args);
      const toolMs = toolComp ? `${toolComp.durationMs}ms tool` : '';
      lines.push(padBetween(`    → ${toolDisp.tool}(${argsStr})`, toolMs, 56));

      if (toolComp && toolComp.result) {
        const preview = toolComp.result.slice(0, FORMAT_RESULT_PREVIEW_CHARS).replace(/\n/g, '\\n');
        const ellipsis = toolComp.result.length > FORMAT_RESULT_PREVIEW_CHARS ? '…' : '';
        lines.push(`    ← ${JSON.stringify(preview + ellipsis)}`);
      }
    }

    lines.push('');
  }

  // Synthesis block
  const synthDone = trace.events.find((e) => e.kind === 'synthesis_completed');
  if (synthDone?.kind === 'synthesis_completed') {
    lines.push(THIN_RULE);
    lines.push(
      `Synthesis (${synthDone.durationMs}ms)${synthDone.hadToolCallEscape ? '  ⚠ tool-call escape detected, retried' : ''}`,
    );
    lines.push(`    ${synthDone.content.slice(0, 200).replace(/\n/g, ' ')}`);
    lines.push('');
  }

  // Result
  lines.push(RULE);
  const foundLabel = result.found ? 'FOUND' : 'NOT FOUND';
  lines.push(`Result:  ${foundLabel}  (${result.terminationReason})`);
  lines.push('');
  if (result.found && result.answer) {
    const answerPreview = result.answer.slice(0, 300).replace(/\n/g, '\n  ');
    lines.push(`  ${answerPreview}${result.answer.length > 300 ? '\n  …' : ''}`);
    lines.push('');
  }

  // Sources
  if (result.sourcesUsed.length > 0) {
    const sourceStrs = result.sourcesUsed.map(
      (s) => `lines ${s.startLine}–${s.endLine}  (${s.tool}, iter ${s.iteration})`,
    );
    lines.push(`Sources: ${sourceStrs.join('   ')}`);
    lines.push('');
  }

  // Metrics
  lines.push(RULE);
  const m = result.metrics;
  lines.push('Metrics:');
  lines.push(
    `  model calls: ${m.modelCallCount}  (${m.totalModelDurationMs}ms total)` +
      `     tool calls: ${Object.values(m.toolFrequency).reduce((a, b) => a + b, 0)}  (${m.totalToolDurationMs}ms total)`,
  );
  lines.push(
    `  chars read: ${m.charsRead.toLocaleString()} / ${corpusMeta.charCount.toLocaleString()}` +
      `  (${(m.coverageRatio * 100).toFixed(2)}%)   peekFirst: ${m.peekFirst ? 'yes' : 'no'}`,
  );
  if (Object.keys(m.toolFrequency).length > 0) {
    const freqStr = Object.entries(m.toolFrequency)
      .map(([k, v]) => `${k}: ${v}`)
      .join('   ');
    lines.push(`  tool usage: ${freqStr}`);
  }
  lines.push(RULE);

  return lines.join('\n');
}

// --------------------------------------------------------------------------
// formatTrace helpers
// --------------------------------------------------------------------------

function groupByIteration(events: RLMEvent[]): Map<number, RLMEvent[]> {
  const groups = new Map<number, RLMEvent[]>();
  for (const e of events) {
    if ('iteration' in e && typeof e.iteration === 'number') {
      const key = e.iteration;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(e);
    }
  }
  // Return sorted by iteration number
  return new Map([...groups.entries()].sort((a, b) => a[0] - b[0]));
}

function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`)
    .join(', ');
}

function padBetween(left: string, right: string, width: number): string {
  if (!right) return left;
  const gap = Math.max(1, width - left.length - right.length);
  return left + ' '.repeat(gap) + right;
}
