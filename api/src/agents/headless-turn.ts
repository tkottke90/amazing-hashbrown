import { randomUUID } from 'node:crypto';
import { env, type ProviderConfig } from '../config/env.js';
import { logger, serializeError } from '../config/logger.js';
import type { ThreadStore } from '../services/thread-store.js';
import { getProviderQueue } from '../services/provider-queue.js';
import { resolveProviderConfig } from '../services/provider-factory.js';
import { broadcast } from '../services/broadcast.js';
import { getActiveSseWriter, setActiveSseWriter, type SseWriter } from './active-sse-writer.js';
import {
  pipeEvents,
  finalizeTurn,
  recoverThrownInterrupt,
  extractPartialAssistantState,
} from './stream-handler.js';
import { recordAssistantStart, failAssistant } from './thread-message-writer.js';
import { classifyChatError } from './error-classification.js';
import { endThreadTurn } from './pending-thread-turns.js';
import {
  resolveTurnModel,
  startTurnObservability,
  warnIfAmbientRunnableConfig,
  type TurnObservability,
} from './turn-observability.js';

// Structural — any LangGraph-based agent built by chat-agent.ts's builders
// satisfies this (same rationale as stream-handler.ts's own unexported
// AgentWithGraph interface, which this is deliberately compatible with).
// Loosely typed (any) rather than pinned to one builder's exact generic
// instantiation — buildChatAgent/buildWorkspaceChatAgent/buildTaskAgent/
// buildSubAgentAgent each produce a structurally different (but compatible)
// ReactAgent<...> type, and function parameter/return positions are not
// covariant enough for a narrower interface to unify all of them.
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface HeadlessAgent {
  streamEvents: (input: any, options: Record<string, unknown>) => AsyncIterable<any>;
  graph: {
    getState: (config: any) => Promise<any>;
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface HeadlessTurnParams {
  threadId: string;
  agent: HeadlessAgent;
  message: string;
  threadStore: ThreadStore;
  provider?: string;
  model?: string;
  recursionLimit?: number;
  workspaceId?: string;
  // Set only when this notification is itself about a task-originated
  // thread — threaded into finalizeTurn's hitl_prompt payload the same way
  // task-execution.ts's own run does, so a /hitl resume on THIS turn (if it
  // asks the user something) re-enqueues correctly rather than resuming an
  // interactive turn. Omitted for chat/workspace-chat parent threads.
  taskId?: string;
  // What started this turn — broadcast in thread_turn_started so an open
  // client can label the thread as busy.
  source: 'wakeup' | 'sub_agent';
  // Set only for a wake-up turn: that wake-up's chain depth, exposed to
  // tools as configurable.wakeupDepth so schedule_wakeup can cap
  // consecutive self-wake-ups (see schedule-wakeup.tool.ts).
  wakeupDepth?: number;
}

// Runs one system-generated turn against an existing thread with no live
// SSE connection watching it — the same headless shape task-execution.ts
// uses for an automated task run (agent already built by the caller,
// stream, pipe, finalize), reused here for a spawn_sub_agent completion
// notification (see sub-agent-notification.ts) and a timed wake-up (see
// wakeup-delivery.ts). Claims the per-thread mutex (active-sse-writer.ts)
// with its own AbortController, so the thread's /stop route cancels it like
// an interactive turn, and tells open clients the thread is busy
// (thread_turn_started); endThreadTurn() releases it. Never throws: a
// failure is written to the thread as an error row instead, and must not
// crash the path that delivered the turn.
export async function runHeadlessTurn(params: HeadlessTurnParams): Promise<void> {
  const { threadId, agent, message, threadStore, taskId } = params;
  const provider = params.provider ?? env.defaultProvider;
  const recursionLimit = params.recursionLimit ?? env.agent?.recursionLimit ?? 100;

  // Forwarding shim, same pattern as task-execution.ts's own sink — matters
  // only if a client happens to already be watching this exact thread
  // (there is no general broadcast mechanism), and as the mutex itself.
  const previousWriter = getActiveSseWriter(threadId);
  const sink: SseWriter = (event) => {
    previousWriter?.(event);
  };
  const controller = new AbortController();
  setActiveSseWriter(threadId, sink, controller);
  broadcast({ type: 'thread_turn_started', threadId, source: params.source });

  // Hoisted above the try block so the catch block below can still reach
  // them to recover a thrown GraphInterrupt — see task-execution.ts's own
  // identical hoisting for the rationale.
  const msgId = randomUUID();
  const turnSentAt = new Date().toISOString();
  const config = {
    configurable: {
      thread_id: threadId,
      ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      ...(params.wakeupDepth !== undefined ? { wakeupDepth: params.wakeupDepth } : {}),
    },
  };
  let assistantSeq: number | null = null;
  // This turn's observability trace (#132/#219), and the error it is closed
  // with — both hoisted so the finally block below can close it whichever
  // branch this function ends in. Mirrors task-execution.ts's identical
  // pattern.
  let turnObs: TurnObservability | undefined;
  let traceError: string | null = null;

  // Mirrors the interactive handlers' catch (stream-handler.ts): a Stop is
  // recorded as cancelled, anything else as a classified error — so the
  // thread shows what happened instead of a turn that silently vanished.
  const recordFailure = (err: unknown, aborted: boolean): void => {
    const {
      segmentId,
      content: partialContent,
      thoughtContent: partialThought,
    } = extractPartialAssistantState(err, msgId);
    if (aborted) {
      traceError = 'Stopped.';
      failAssistant(
        threadStore,
        threadId,
        segmentId,
        partialContent,
        turnSentAt,
        partialThought,
        'Stopped.',
        'cancelled',
      );
      return;
    }
    const classified = classifyChatError(err, providerTypeOf(provider));
    // category/elapsedMs are here specifically so an 'interrupted'
    // classification (LangGraph's own framework-level abort — see
    // error-classification.ts's classifyFrameworkAbort) is correlatable
    // after the fact: how soon after the turn started it fired is the one
    // signal available to narrow down what aborted the run's signal, since
    // the thrown error itself carries no further detail.
    logger.error('headless-turn: turn failed', {
      threadId,
      category: classified.category,
      elapsedMs: Date.now() - Date.parse(turnSentAt),
      err: serializeError(err),
    });
    traceError = classified.message;
    failAssistant(
      threadStore,
      threadId,
      segmentId,
      partialContent,
      turnSentAt,
      partialThought,
      classified.message,
      classified.category,
    );
  };

  try {
    const { provider: resolvedProvider, model: resolvedModel } = resolveTurnModel(
      provider,
      params.model,
    );
    turnObs = startTurnObservability({
      threadId,
      ...(taskId ? { taskId } : {}),
      provider: resolvedProvider,
      model: resolvedModel,
      // No systemPrompt: the agent is pre-built by the caller and this
      // function never sees the prompt that built it.
      source: params.source === 'wakeup' ? 'wakeup' : 'sub-agent-notification',
    });

    const startedAt = Date.now();
    assistantSeq = recordAssistantStart(
      threadStore,
      threadId,
      msgId,
      turnSentAt,
      resolvedProvider,
      resolvedModel,
    );

    const { content, thoughtContent, finalSegmentId, hadToolCall } =
      await getProviderQueue().withSlot(
        resolvedProvider,
        'sync',
        async () => {
          warnIfAmbientRunnableConfig({ threadId, source: params.source });
          const rawStream = agent.streamEvents(
            { messages: [{ role: 'human', content: message }] },
            turnObs!.attach({
              ...config,
              version: 'v2',
              recursionLimit,
              context: { provider, model: params.model, afterAgentEnabled: undefined },
              signal: controller.signal,
            }),
          );
          return pipeEvents(sink, msgId, rawStream, threadStore, threadId, turnSentAt);
        },
        { signal: controller.signal },
      );

    await finalizeTurn(
      sink,
      threadStore,
      agent,
      threadId,
      finalSegmentId,
      startedAt,
      content,
      thoughtContent,
      hadToolCall,
      turnSentAt,
      assistantSeq,
      null,
      turnObs.obsHandler,
      resolvedProvider,
      resolvedModel,
      taskId,
    );
  } catch (err) {
    const recovered = await recoverThrownInterrupt(
      err,
      sink,
      threadStore,
      threadId,
      msgId,
      turnSentAt,
      assistantSeq,
      null,
      taskId,
    );
    if (!recovered) recordFailure(err, controller.signal.aborted);
  } finally {
    await turnObs?.end(traceError);
    endThreadTurn(threadId);
  }
}

// Provider type for error classification; undefined when the provider is no
// longer configured (classification then falls back to generic matching).
function providerTypeOf(provider: string): ProviderConfig['type'] | undefined {
  try {
    return resolveProviderConfig(provider).type;
  } catch {
    return undefined;
  }
}
