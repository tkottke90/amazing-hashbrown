import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';
import type { Serialized } from '@langchain/core/load/serializable';
import type { ObservabilityStore, SpanRecord } from '@tkottke90/observability';
import { estimateTokens } from '@tkottke90/llm-common-types/tokens';

export class ObservabilityCallbackHandler extends BaseCallbackHandler {
  readonly name = 'observability';

  private readonly pending = new Map<string, Partial<SpanRecord>>();
  private readonly completed: SpanRecord[] = [];

  // Set by callers ahead of an .invoke() and read by the next handleLLMStart.
  // Needed because RunnableConfig's `runName` (the 8th handleLLMStart param
  // below) only labels the outermost run of a chain — it does NOT propagate
  // down through .withStructuredOutput()/.withRetry() to the inner chat
  // model's own LLM-call run, which is what actually reaches this handler.
  // Confirmed empirically: handleLLMStart's runName param is always
  // undefined for such chains, regardless of the runName passed to invoke().
  // Not cleared after one use — .withRetry() re-invokes the whole chain
  // (and therefore handleLLMStart) internally on each retry attempt, all of
  // which are still the same logical step and should get the same name.
  private nextSpanName: string | null = null;

  totalInputTokens = 0;
  totalOutputTokens = 0;
  turnDurationMs = 0;
  lastContextWindowInputTokens = 0;

  constructor(
    private readonly traceId: string,
    private readonly store: ObservabilityStore,
    private readonly previewChars: number,
  ) {
    super();
  }

  /** Names the next LLM-call span(s), overriding both the derived model name
   * and any (non-functional, for chained/retried calls) runName param. Stays
   * in effect until the next call — see field comment above. */
  setNextSpanName(name: string): void {
    this.nextSpanName = name;
  }

  override async handleLLMStart(
    llm: Serialized,
    _prompts: string[],
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    const derivedName =
      (llm as { id?: string[] }).id?.at(-1) ?? (llm as { name?: string }).name ?? 'unknown-model';
    const name = this.nextSpanName ?? runName ?? derivedName;

    this.pending.set(runId, {
      spanId: runId,
      traceId: this.traceId,
      parentSpanId: parentRunId ?? null,
      type: 'llm-call',
      name,
      startedAt: new Date().toISOString(),
    });
  }

  override async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    const span = this.pending.get(runId);
    if (!span) return;

    const endedAt = new Date().toISOString();

    const llmOutput: Record<string, unknown> = output.llmOutput ?? {};
    const usage = (llmOutput['usage_metadata'] ?? llmOutput['tokenUsage']) as
      Record<string, number> | null | undefined;

    const firstGen = output.generations[0]?.[0];
    const text = (firstGen as { text?: string } | undefined)?.text ?? '';

    const inputTokens: number =
      usage?.['input_tokens'] ?? usage?.['promptTokens'] ?? estimateTokens(text);
    const outputTokens: number =
      usage?.['output_tokens'] ?? usage?.['completionTokens'] ?? estimateTokens(text);

    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.turnDurationMs += new Date(endedAt).getTime() - new Date(span.startedAt!).getTime();
    this.lastContextWindowInputTokens = inputTokens;

    const toolCalls =
      (firstGen as { message?: { tool_calls?: unknown[] } } | undefined)?.message?.tool_calls ?? [];
    const outputPreview =
      toolCalls.length > 0 ? this.preview(JSON.stringify(toolCalls)) : this.preview(text);

    this.completed.push({
      ...(span as SpanRecord),
      endedAt,
      latencyMs: new Date(endedAt).getTime() - new Date(span.startedAt!).getTime(),
      inputTokens,
      outputTokens,
      outputPreview,
      inputPreview: null,
      error: null,
      interrupted: false,
    });
    this.pending.delete(runId);
  }

  override async handleLLMError(err: Error, runId: string): Promise<void> {
    const span = this.pending.get(runId);
    if (!span) return;
    const endedAt = new Date().toISOString();
    this.completed.push({
      ...(span as SpanRecord),
      endedAt,
      latencyMs: new Date(endedAt).getTime() - new Date(span.startedAt!).getTime(),
      inputTokens: null,
      outputTokens: null,
      outputPreview: null,
      inputPreview: null,
      error: err.message,
      interrupted: false,
    });
    this.pending.delete(runId);
  }

  override async handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
  ): Promise<void> {
    const name =
      (tool as { name?: string }).name ?? (tool as { id?: string[] }).id?.at(-1) ?? 'unknown-tool';

    this.pending.set(runId, {
      spanId: runId,
      traceId: this.traceId,
      parentSpanId: parentRunId ?? null,
      type: 'tool-call',
      name,
      startedAt: new Date().toISOString(),
      inputPreview: input,
      inputTokens: null,
      outputTokens: null,
    });
  }

  override async handleToolEnd(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    output: any,
    runId: string,
  ): Promise<void> {
    const span = this.pending.get(runId);
    if (!span) return;
    const endedAt = new Date().toISOString();
    const result = typeof output === 'string' ? output : JSON.stringify(output);
    this.completed.push({
      ...(span as SpanRecord),
      endedAt,
      latencyMs: new Date(endedAt).getTime() - new Date(span.startedAt!).getTime(),
      outputPreview: this.preview(result),
      error: null,
      interrupted: false,
    });
    this.pending.delete(runId);
  }

  // GraphInterrupt is LangGraph's own interrupt() control-flow signal — the
  // same codebase-wide convention used to recognize it in stream-handler.ts/
  // task-execution.ts/the loop guard: by `.name`, not `instanceof` (it
  // crosses at least one wrapper — PipeEventsError further up the stack —
  // that only preserves `.name`). ask_user/shell_exec throw it from inside
  // their tool function to pause the graph for a HITL answer; that's a
  // successful, expected pause recoverThrownInterrupt handles further up the
  // stack, never a tool failure, so it must not be recorded as span.error
  // (see ADR-0075, GLOSSARY.md "Interrupted Span") — thread-reports' own
  // failureCount/Failure Breakdown key off error !== null with no knowledge
  // of tool names, so leaving error null here is what actually excludes it.
  override async handleToolError(err: Error, runId: string): Promise<void> {
    const span = this.pending.get(runId);
    if (!span) return;
    const endedAt = new Date().toISOString();
    const interrupted = err.name === 'GraphInterrupt';
    this.completed.push({
      ...(span as SpanRecord),
      endedAt,
      latencyMs: new Date(endedAt).getTime() - new Date(span.startedAt!).getTime(),
      outputPreview: null,
      error: interrupted ? null : err.message,
      interrupted,
    });
    this.pending.delete(runId);
  }

  override async handleChainEnd(): Promise<void> {
    this.flushCompleted();
  }

  // Fires instead of handleChainEnd when the graph run throws (e.g. the
  // provider errors out mid-stream) — the base class's handleChainError is a
  // no-op, so without this override every span already captured in
  // `completed` (including an errored llm-call span from handleLLMError
  // above) would be silently dropped instead of reaching saveSpans().
  override async handleChainError(err: Error): Promise<void> {
    this.flushPendingAsFailed(err);
    this.flushCompleted();
  }

  private flushCompleted(): void {
    if (this.completed.length > 0) {
      this.store.saveSpans(this.completed);
      this.completed.length = 0;
    }
  }

  // Any span still in `pending` when the whole chain/graph fails never got
  // its own handleLLMEnd/handleLLMError/handleToolEnd/handleToolError — it
  // was cut off mid-flight (e.g. a tool call in progress when the run was
  // torn down). Synthesize a terminal, errored span for each so it still
  // shows up in the Thread Report instead of silently vanishing.
  private flushPendingAsFailed(err: Error): void {
    if (this.pending.size === 0) return;
    const endedAt = new Date().toISOString();
    for (const span of this.pending.values()) {
      this.completed.push({
        ...(span as SpanRecord),
        endedAt,
        latencyMs: new Date(endedAt).getTime() - new Date(span.startedAt!).getTime(),
        inputTokens: span.inputTokens ?? null,
        outputTokens: span.outputTokens ?? null,
        outputPreview: null,
        inputPreview: span.inputPreview ?? null,
        error: `turn failed before this span completed: ${err.message}`,
        interrupted: false,
      });
    }
    this.pending.clear();
  }

  private preview(text: string): string | null {
    if (this.previewChars === 0) return null;
    if (this.previewChars === -1) return text;
    return text.slice(0, this.previewChars);
  }
}
