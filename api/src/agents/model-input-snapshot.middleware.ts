import { createMiddleware } from 'langchain';
import type { ObservabilityStore } from '@tkottke90/observability';
import { getObservabilityStore } from '../services/observability.js';
import { logger, serializeError } from '../config/logger.js';

// Snapshots what the model actually received on a turn — the bound tool
// names and the final system message — onto the turn's observability trace,
// so the thread report can answer "was tool X bound on this turn?" (issue
// #207). Purely observational: the request is always handed to the handler
// unmodified.
//
// Must be the LAST entry in an agent's middleware array. wrapModelCall hooks
// nest in array order, so the last one is innermost and sees request.tools
// and request.systemMessage only after skillGatedToolsMiddleware and
// toolAccessMiddleware have filtered/rewritten them. Anywhere earlier would
// record the unfiltered build-time set — the same misleading picture the
// tool drawer already shows.
//
// The trace id is read per call from request.runtime.configurable (set by the
// stream handlers next to thread_id), not closed over at build time, because
// built agents are cached per provider:model and shared across turns and
// threads — same reasoning as tool-access.middleware.ts's thread_id read.
// No trace_id (startup warm-up build, evals, task runs that don't open a
// trace) means there is nothing to record against, so it's a pass-through.
//
// A turn can make several model calls (tool loops); only the first is kept.
// That rule lives in ObservabilityStore.recordModelInput's SQL guard, so this
// middleware holds no per-trace state of its own.
//
// A factory (like createToolAccessMiddleware) so tests can inject a fake
// store; production code uses the modelInputSnapshotMiddleware singleton.
export function createModelInputSnapshotMiddleware(
  getStore: () => Pick<ObservabilityStore, 'recordModelInput'> = getObservabilityStore,
) {
  return createMiddleware({
    name: 'ModelInputSnapshotMiddleware',
    wrapModelCall: async (request, handler) => {
      const traceId = request.runtime.configurable?.trace_id;
      if (typeof traceId === 'string' && traceId) {
        try {
          const content = request.systemMessage.content;
          getStore().recordModelInput(traceId, {
            tools: request.tools.map((tool) => tool.name as string),
            systemPrompt: typeof content === 'string' ? content : undefined,
          });
        } catch (err) {
          // Observability must never take down a chat turn.
          logger.warn('model-input-snapshot: failed to record model input', {
            traceId,
            err: serializeError(err as Error),
          });
        }
      }
      return handler(request);
    },
  });
}

export const modelInputSnapshotMiddleware = createModelInputSnapshotMiddleware();
