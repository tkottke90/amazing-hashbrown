import type { TraceSource } from '@tkottke90/llm-common-types/traces';
import { env } from '../config/env.js';
import { getObservabilityStore } from '../services/observability.js';
import { resolveProviderConfig } from '../services/provider-factory.js';
import { ObservabilityCallbackHandler } from './observability-handler.js';

// Composable pieces for giving an agent turn an observability trace and the
// usage metrics finalizeTurn() persists (#132). Deliberately not a wrapper
// that owns the turn — turn runners differ too much in their streaming, HITL
// and error paths for that. Only task-execution.ts uses this so far; moving
// the other turn runners' inline copies onto it is #219.

// Resolves what a turn will actually run on: the provider's configured name
// and a concrete model. A turn that leaves the model undefined can never
// match a configured cost rate (keyed `${provider}/${model}`) — the bug #131
// fixed for chat — so this is the one place that resolution happens.
export function resolveTurnModel(
  provider?: string,
  model?: string,
): { provider: string; model: string } {
  const config = resolveProviderConfig(provider);
  const resolvedModel = model ?? config.defaultModel;
  if (!resolvedModel) {
    throw new Error(`Provider "${config.name}" has no defaultModel and none was passed`);
  }
  return { provider: config.name, model: resolvedModel };
}

export interface TurnObservability {
  traceId: string;
  obsHandler: ObservabilityCallbackHandler;
  // Returns a copy of a streamEvents config with the handler added as a
  // callback and trace_id merged into configurable (model-input-snapshot
  // middleware keys the per-turn tool snapshot on it — #207), keeping the
  // caller's own configurable keys.
  attach<const C extends { configurable: Record<string, unknown> }>(
    config: C,
  ): C & {
    configurable: C['configurable'] & { trace_id: string };
    callbacks: ObservabilityCallbackHandler[];
  };
  // Closes the trace with the handler's token totals. Only the first call
  // writes, so a finally-block cleanup can't overwrite an error recorded
  // earlier.
  end(error?: string | null): Promise<void>;
}

export interface StartTurnObservabilityParams {
  // Optional — matches the store's own StartTraceParams: a turn with no
  // thread yet (e.g. plan-generation.ts, which runs before any task/thread
  // exists) still gets a trace, just with no threadId to attribute it to.
  threadId?: string;
  taskId?: string;
  // Already resolved — see resolveTurnModel().
  provider: string;
  model: string;
  source: TraceSource;
  systemPrompt?: string;
}

export function startTurnObservability(params: StartTurnObservabilityParams): TurnObservability {
  const store = getObservabilityStore();
  const traceId = store.startTrace(params);
  const obsHandler = new ObservabilityCallbackHandler(
    traceId,
    store,
    env.observability.spanOutputPreviewChars,
  );
  let closed = false;

  return {
    traceId,
    obsHandler,
    attach(config) {
      return {
        ...config,
        configurable: { ...config.configurable, trace_id: traceId },
        callbacks: [obsHandler],
      };
    },
    async end(error = null) {
      if (closed) return;
      closed = true;
      // A bare model.invoke() (no chain/graph wrapping it) never fires
      // handleChainEnd on its own, so every caller used to have to remember
      // to call it before closing the trace — folded in here so no call
      // site can forget it. Safe no-op for streaming/graph callers, whose
      // own callback machinery already flushed the handler by this point.
      await obsHandler.handleChainEnd();
      store.endTrace(traceId, {
        totalTokens: obsHandler.totalInputTokens + obsHandler.totalOutputTokens,
        error,
      });
    },
  };
}
