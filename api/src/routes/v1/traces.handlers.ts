import type { ObservabilityStore } from '@tkottke90/observability';
import type { ThreadStore } from '../../services/thread-store.js';
import { buildScenarioSource, type ScenarioSource } from '@tkottke90/evaluations';

// Plain, Express-agnostic handler function — no req/res anywhere. See the
// same pattern in threads.handlers.ts/tasks.handlers.ts.

export interface HandlerFailure {
  ok: false;
  status: 404 | 400 | 409 | 422 | 500;
  error: string;
}

export type HandlerResult<T> = { ok: true; data: T } | HandlerFailure;

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function notFound(error: string): HandlerFailure {
  return { ok: false, status: 404, error };
}

/**
 * Joins a trace with its linked thread's full (uncapped) message history
 * into scenario-authoring-ready data — see
 * lib/evaluations/src/trace-scenario-source.ts for why the trace's own
 * spans alone aren't enough (llm-call input is never captured there, and
 * tool-call output previews are truncated).
 */
export function getScenarioSourceHandler(
  observabilityStore: ObservabilityStore,
  threadStore: ThreadStore,
  traceId: string,
): HandlerResult<ScenarioSource> {
  const trace = observabilityStore.getTrace(traceId);
  if (!trace) return notFound(`Trace ${traceId} not found`);

  // getThreadMessages defaults to a 200-message display cap — override it
  // here since a scenario needs the thread's full, untruncated history.
  const messages = trace.threadId
    ? threadStore.getThreadMessages(trace.threadId, { limit: Number.MAX_SAFE_INTEGER })
    : [];

  return ok(buildScenarioSource(trace, messages));
}
