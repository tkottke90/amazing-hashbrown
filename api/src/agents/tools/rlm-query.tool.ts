import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { RLMRunner } from '@tkottke90/rlm';
import type { RLMTrace, RLMEvent } from '@tkottke90/rlm';
import type { SpanRecord } from '@tkottke90/observability';
import { logger, serializeError } from '../../config/logger.js';
import { env } from '../../config/env.js';
import { createProvider } from '../../services/provider-factory.js';
import { LangChainInferenceAdapter } from '../../services/rlm-adapter.js';
import { createEmbeddingAdapter } from '../../services/rlm-embedding-adapter.js';
import { getObservabilityStore } from '../../services/observability.js';

const PREVIEW_CHARS = 500;

const RLMQuerySchema = z.object({
  question: z.string().describe('The specific question to answer from the corpus'),
  corpus: z
    .string()
    .describe(
      'The full text to search through. Obtain from wiki_read_page with truncate: false, ' +
        'or from any other large text source such as web_fetch.',
    ),
});

function buildRLMSpans(
  trace: RLMTrace,
  parentSpanId: string | null,
  modelName: string,
): SpanRecord[] {
  const spans: SpanRecord[] = [];

  // correlationId → { spanId, startedAt } for model call pairs
  const pendingModelSpans = new Map<string, { spanId: string; startedAt: string }>();
  // iteration → llm-call spanId (so tool calls can reference their parent model call)
  const iterationToModelSpanId = new Map<number, string>();
  // correlationId → { spanId, startedAt, parentSpanId, name, argsPreview } for tool pairs
  const pendingToolSpans = new Map<
    string,
    { spanId: string; startedAt: string; parentSpanId: string | null; name: string; argsPreview: string }
  >();

  for (const event of trace.events as RLMEvent[]) {
    const ts = new Date(event.timestampMs).toISOString();

    switch (event.kind) {
      case 'model_requested': {
        const spanId = randomUUID();
        pendingModelSpans.set(event.correlationId, { spanId, startedAt: ts });
        iterationToModelSpanId.set(event.iteration, spanId);
        break;
      }

      case 'model_responded': {
        const pending = pendingModelSpans.get(event.correlationId);
        if (!pending) break;
        pendingModelSpans.delete(event.correlationId);
        spans.push({
          spanId: pending.spanId,
          traceId: trace.traceId,
          parentSpanId,
          type: 'llm-call',
          name: modelName,
          startedAt: pending.startedAt,
          endedAt: ts,
          latencyMs: event.durationMs,
          inputTokens: null,
          outputTokens: null,
          outputPreview: event.content.slice(0, PREVIEW_CHARS) || null,
          inputPreview: null,
          error: null,
        });
        break;
      }

      case 'tool_dispatched': {
        const spanId = randomUUID();
        const modelSpanId = iterationToModelSpanId.get(event.iteration) ?? parentSpanId;
        pendingToolSpans.set(event.correlationId, {
          spanId,
          startedAt: ts,
          parentSpanId: modelSpanId,
          name: `rlm:${event.tool}`,
          argsPreview: JSON.stringify(event.args).slice(0, PREVIEW_CHARS),
        });
        break;
      }

      case 'tool_completed': {
        const pending = pendingToolSpans.get(event.correlationId);
        if (!pending) break;
        pendingToolSpans.delete(event.correlationId);
        spans.push({
          spanId: pending.spanId,
          traceId: trace.traceId,
          parentSpanId: pending.parentSpanId,
          type: 'tool-call',
          name: pending.name,
          startedAt: pending.startedAt,
          endedAt: ts,
          latencyMs: event.durationMs,
          inputTokens: null,
          outputTokens: null,
          outputPreview: event.result.slice(0, PREVIEW_CHARS) || null,
          inputPreview: pending.argsPreview,
          error: null,
        });
        break;
      }

      case 'synthesis_triggered': {
        const spanId = randomUUID();
        pendingModelSpans.set(event.correlationId, { spanId, startedAt: ts });
        break;
      }

      case 'synthesis_completed': {
        const pending = pendingModelSpans.get(event.correlationId);
        if (!pending) break;
        pendingModelSpans.delete(event.correlationId);
        spans.push({
          spanId: pending.spanId,
          traceId: trace.traceId,
          parentSpanId,
          type: 'llm-call',
          name: `${modelName}:synthesis`,
          startedAt: pending.startedAt,
          endedAt: ts,
          latencyMs: event.durationMs,
          inputTokens: null,
          outputTokens: null,
          outputPreview: event.content.slice(0, PREVIEW_CHARS) || null,
          inputPreview: null,
          error: null,
        });
        break;
      }
    }
  }

  return spans;
}

export const rlmQueryTool = tool(
  async ({ question, corpus }, config) => {
    const rlmConfig = env.rlm;
    const resolvedModel = rlmConfig.model;
    const langChainModel = createProvider(rlmConfig.provider, resolvedModel);
    const adapter = new LangChainInferenceAdapter(langChainModel);
    const embeddingAdapter = createEmbeddingAdapter(env.embeddings);

    let capturedTrace: RLMTrace | undefined;
    const runner = new RLMRunner(
      adapter,
      embeddingAdapter,
      { maxIterations: rlmConfig.maxIterations },
      { onTrace: (t) => { capturedTrace = t; } },
    );

    let result;
    try {
      result = await runner.run(question, { text: corpus, source: 'rlm_query' });
    } catch (err) {
      logger.error('rlm_query: runner failed', { err: serializeError(err) });
      return `rlm_query failed: ${(err as Error).message}`;
    }

    // Write internal RLM execution trace to observability store.
    if (capturedTrace) {
      try {
        const providerName = rlmConfig.provider ?? env.defaultProvider ?? 'unknown';
        const modelName = resolvedModel ?? providerName;
        const parentSpanId = (config as { runId?: string } | undefined)?.runId ?? null;
        const spans = buildRLMSpans(capturedTrace, parentSpanId, modelName);

        if (spans.length > 0) {
          const store = getObservabilityStore();
          store.saveSpans(spans);
        }
      } catch (err) {
        logger.warn('rlm_query: failed to write observability spans', { err: serializeError(err) });
      }
    }

    const prefix = result.found
      ? ''
      : 'No direct answer found within the corpus. Best available response:\n\n';

    const toolFreq = Object.entries(result.metrics.toolFrequency)
      .map(([k, v]) => `${k}×${v}`)
      .join(', ');

    return (
      prefix +
      result.answer +
      `\n\n---\nRLM: ${result.iterations} iteration(s) · ${result.terminationReason} · ${result.totalDurationMs}ms` +
      (toolFreq ? `\nTools: ${toolFreq}` : '')
    );
  },
  {
    name: 'rlm_query',
    description:
      'Answer a specific question by iteratively searching through a large text corpus. ' +
      'Use this when wiki_read_page returns a truncation notice, or when you have any large ' +
      'text (from web_fetch or another source) and need to find specific information within it. ' +
      'Obtain the corpus by calling wiki_read_page with truncate: false.',
    schema: RLMQuerySchema,
  },
);
