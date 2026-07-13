import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';
import type { Serialized } from '@langchain/core/load/serializable';
import type { ObservabilityStore, SpanRecord } from '@tkottke90/observability';

// Simple char-based token estimate (4 chars ≈ 1 token) used when the
// provider does not return usage_metadata in the LLM response.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class ObservabilityCallbackHandler extends BaseCallbackHandler {
  readonly name = 'observability';

  private readonly pending = new Map<string, Partial<SpanRecord>>();
  private readonly completed: SpanRecord[] = [];

  totalInputTokens = 0;
  totalOutputTokens = 0;

  constructor(
    private readonly traceId: string,
    private readonly store: ObservabilityStore,
    private readonly previewChars: number,
  ) {
    super();
  }

  override async handleLLMStart(
    llm: Serialized,
    _prompts: string[],
    runId: string,
    parentRunId?: string,
  ): Promise<void> {
    const name =
      (llm as { id?: string[] }).id?.at(-1) ?? (llm as { name?: string }).name ?? 'unknown-model';

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
      | Record<string, number>
      | null
      | undefined;

    const firstGen = output.generations[0]?.[0];
    const text = (firstGen as { text?: string } | undefined)?.text ?? '';

    const inputTokens: number = usage?.['input_tokens'] ?? usage?.['promptTokens'] ?? estimateTokens(text);
    const outputTokens: number =
      usage?.['output_tokens'] ?? usage?.['completionTokens'] ?? estimateTokens(text);

    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;

    const toolCalls =
      (
        firstGen as { message?: { tool_calls?: unknown[] } } | undefined
      )?.message?.tool_calls ?? [];
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
    });
    this.pending.delete(runId);
  }

  override async handleToolError(err: Error, runId: string): Promise<void> {
    const span = this.pending.get(runId);
    if (!span) return;
    const endedAt = new Date().toISOString();
    this.completed.push({
      ...(span as SpanRecord),
      endedAt,
      latencyMs: new Date(endedAt).getTime() - new Date(span.startedAt!).getTime(),
      outputPreview: null,
      error: err.message,
    });
    this.pending.delete(runId);
  }

  override async handleChainEnd(): Promise<void> {
    if (this.completed.length > 0) {
      this.store.saveSpans(this.completed);
    }
  }

  private preview(text: string): string | null {
    if (this.previewChars === 0) return null;
    if (this.previewChars === -1) return text;
    return text.slice(0, this.previewChars);
  }
}
