import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import type { TraceSource } from '@tkottke90/llm-common-types/traces';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
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
  // The Azure OpenAI Provider has no defaultModel — its Deployment Name is
  // its one "model" (see GLOSSARY.md "Deployment Name").
  const resolvedModel =
    model ?? (config.type === 'azure-openai' ? config.deploymentName : config.defaultModel);
  if (!resolvedModel) {
    throw new Error(`Provider "${config.name}" has no defaultModel and none was passed`);
  }
  return { provider: config.name, model: resolvedModel };
}

// Fix (not just a diagnostic) for the 'interrupted' error category
// (error-classification.ts). @langchain/core's ensureConfig() resolves a
// Runnable's ambient AsyncLocalStorage-propagated RunnableConfig
// *synchronously*, at the moment streamEvents()/invoke() is called, and
// merges in anything that config carries — notably `timeout`, which becomes
// an AbortSignal.timeout() combined into the call's own AbortSignal via
// AbortSignal.any(). That derived signal is a *different object* from the
// one our own AbortController exposes, so it can abort a turn without
// `controller.signal.aborted` ever reading true — confirmed by reproducing
// this exact mechanism against the installed @langchain/langgraph, which is
// what originally prompted a warning-only version of this check (see git
// history). Nothing in this codebase calls runWithConfig() itself, so
// getRunnableConfig() should always read undefined — the real source traced
// to @langchain/core's own tool-invocation path (tools/index.js wraps a
// tool's function body in runWithConfig()), combined with ProviderQueue
// resolving a *queued* caller's acquireSlot() promise synchronously from
// inside whatever AsyncLocalStorage scope happens to be active at
// releaseSlot() time: a dequeued caller's `await acquireSlot()` continuation
// — including everything it does afterward, like this very streamEvents()
// call — inherits the context active wherever its resolve() was invoked,
// not the context where it was awaited. A cron task firing shortly after an
// unrelated turn's own tool call can land its first LLM call inside that
// still-active, unrelated ALS scope purely by queueing timing, with no
// causal relationship to the leaked config's actual turn at all.
//
// Rather than chase every possible leak source (tool invocation today,
// anything else tomorrow), this scopes every streamEvents() call inside a
// *guaranteed-clean* AsyncLocalStorage context via the same public
// AsyncLocalStorageProviderSingleton.getInstance() LangChain itself reads
// from — closing the whole bug class at its one real choke point instead of
// treating each leak source as its own bug. Call immediately before every
// agent.streamEvents() call site — ensureConfig() reads the ambient config
// at call time, not lazily when the stream is first iterated, so clearing
// any later (even at the top of pipeEvents) would already be too late.
export function clearAmbientRunnableConfig<T>(context: Record<string, unknown>, fn: () => T): T {
  const ambient = AsyncLocalStorageProviderSingleton.getRunnableConfig();
  if (ambient) {
    logger.warn(
      "turn-observability: ambient RunnableConfig present before streamEvents() — clearing it so this turn's AbortSignal isn't silently replaced by a leaked short-lived one",
      {
        ...context,
        ambientKeys: Object.keys(ambient),
        ambientTimeout: (ambient as { timeout?: number }).timeout,
        ambientHasSignal: 'signal' in ambient,
      },
    );
  }
  return AsyncLocalStorageProviderSingleton.getInstance().run(undefined, fn);
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
