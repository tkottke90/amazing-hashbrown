import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { Command } from '@langchain/langgraph';
import { logger, serializeError } from '../config/logger.js';
import type {
  ChatSSEEvent,
  ChatErrorCategory,
  UserMessageAttachment,
} from '@tkottke90/llm-common-types/chat';
import { classifyChatError } from './error-classification.js';
import { getChatAgent, type ChatAgent } from './chat-agent.js';
import { setActiveSseWriter, getActiveSseWriter, type SseWriter } from './active-sse-writer.js';
import { endThreadTurn } from './pending-thread-turns.js';
import { env } from '../config/env.js';
import { getThreadStore, type ThreadStore } from '../services/thread-store.js';
import { resolveTurnModel, startTurnObservability } from './turn-observability.js';
import { getObservabilityStore } from '../services/observability.js';
import { drainPendingWikiUpdates } from './after-agent.js';
import {
  recordUserMessage,
  recordAssistantStart,
  finalizeAssistant,
  failAssistant,
  recordRetryAttempt,
  recordToolCallStart,
  finalizeToolCall,
  recordHitlPrompt,
  resolveHitlPrompt,
  recordWikiUpdate,
  recordResourceCard,
  type AssistantMetrics,
} from './thread-message-writer.js';
import { extractToolResultContent } from './tool-output.js';
import { markArtifactReferenced } from '../artifacts/artifact-store.js';
import { resolveProviderConfig } from '../services/provider-factory.js';
import { getProviderQueue } from '../services/provider-queue.js';
import { resolveAttachmentsForTurn, buildAttachmentSpan } from './attachment-resolution.js';

// ---- SSE write helper ----

export function writeSseEvent(sink: SseWriter, event: ChatSSEEvent): void {
  sink(event);
}

// ---- Thought-block parser ----
// Parses <think>...</think> tokens from a streaming LLM response.
// Maintains buffer state across chunk boundaries so split tags are handled
// correctly. `content`/`thought` accumulate exactly what gets emitted to the
// client at each delta, so the persisted final text matches the live stream
// byte for byte — see thread-message-writer.ts's finalizeAssistant.

interface ParseState {
  inThought: boolean;
  buf: string;
  content: string;
  thought: string;
}

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';
const SAFE_MARGIN = Math.max(OPEN_TAG.length, CLOSE_TAG.length);

function flushDelta(sink: SseWriter, msgId: string, state: ParseState, chunk: string): void {
  state.buf += chunk;

  while (state.buf.length > 0) {
    if (state.inThought) {
      const closeIdx = state.buf.indexOf(CLOSE_TAG);
      if (closeIdx >= 0) {
        if (closeIdx > 0) {
          const delta = state.buf.slice(0, closeIdx);
          state.thought += delta;
          writeSseEvent(sink, { type: 'thought_delta', messageId: msgId, delta });
        }
        state.buf = state.buf.slice(closeIdx + CLOSE_TAG.length);
        state.inThought = false;
      } else {
        const safe = state.buf.length > SAFE_MARGIN ? state.buf.slice(0, -SAFE_MARGIN) : '';
        if (safe) {
          state.thought += safe;
          writeSseEvent(sink, { type: 'thought_delta', messageId: msgId, delta: safe });
          state.buf = state.buf.slice(safe.length);
        }
        break;
      }
    } else {
      const openIdx = state.buf.indexOf(OPEN_TAG);
      if (openIdx >= 0) {
        if (openIdx > 0) {
          const delta = state.buf.slice(0, openIdx);
          state.content += delta;
          writeSseEvent(sink, { type: 'text_delta', messageId: msgId, delta });
        }
        state.buf = state.buf.slice(openIdx + OPEN_TAG.length);
        state.inThought = true;
      } else {
        const safe = state.buf.length > SAFE_MARGIN ? state.buf.slice(0, -SAFE_MARGIN) : '';
        if (safe) {
          state.content += safe;
          writeSseEvent(sink, { type: 'text_delta', messageId: msgId, delta: safe });
          state.buf = state.buf.slice(safe.length);
        }
        break;
      }
    }
  }
}

function drainBuffer(sink: SseWriter, msgId: string, state: ParseState): void {
  if (state.buf) {
    if (state.inThought) state.thought += state.buf;
    else state.content += state.buf;
    writeSseEvent(sink, {
      type: state.inThought ? 'thought_delta' : 'text_delta',
      messageId: msgId,
      delta: state.buf,
    });
    state.buf = '';
  }
}

// ---- LangGraph event → SSE (+ thread_messages persistence) ----

// Thrown when the LangGraph event stream itself throws mid-turn. Carries
// whatever text had already streamed to the client in the segment that was
// open at the time, so callers can persist real partial content instead of
// discarding it — see extractPartialAssistantState and
// thread-message-writer.ts's failAssistant.
export class PipeEventsError extends Error {
  readonly segmentId: string;
  readonly partialContent: string;
  readonly partialThought: string;
  // The original thrown value, untouched — provider SDK errors carry the
  // structured fields (status/type/code) classifyChatError keys off, which
  // this wrapper's own message/name copy doesn't preserve.
  readonly sourceError: unknown;

  constructor(
    sourceErr: unknown,
    segmentId: string,
    partialContent: string,
    partialThought: string,
  ) {
    super(sourceErr instanceof Error ? sourceErr.message : String(sourceErr));
    // Preserve the original error's name (e.g. 'GraphRecursionError') so the
    // existing `(err as Error).name === 'GraphRecursionError'` checks below
    // (and in the wiki/workspace equivalents) keep working against this
    // wrapper without change.
    this.name = sourceErr instanceof Error ? sourceErr.name : 'PipeEventsError';
    this.segmentId = segmentId;
    this.partialContent = partialContent;
    this.partialThought = partialThought;
    this.sourceError = sourceErr;
  }
}

// Thrown from a turn's own catch block (in place of the raw provider error)
// once its failure has been classified — carries the classification so the
// outer route-layer catch (which only ever sees `unknown` at that point)
// can put `errorCategory` on the live `stream_error` SSE event without
// re-deriving the provider/classification itself. See error-classification.ts.
export class ClassifiedTurnError extends Error {
  readonly category: ChatErrorCategory;
  // Per-attachment outcomes already resolved before the turn failed (see
  // attachment-resolution.ts) — carried here because the route-layer catch
  // that builds the stream_error event has no other way to reach them once
  // control leaves the stream handler's own closure. Absent for a turn that
  // never had attachments, or whose failure happened before resolution.
  readonly attachments?: UserMessageAttachment[];

  constructor(message: string, category: ChatErrorCategory, attachments?: UserMessageAttachment[]) {
    super(message);
    this.name = 'ClassifiedTurnError';
    this.category = category;
    this.attachments = attachments;
  }
}

// Recovers whatever partial assistant content/segment id was in flight when
// pipeEvents threw, falling back to the turn's original message id and empty
// content for any other error shape (e.g. thrown before pipeEvents ran).
export function extractPartialAssistantState(
  err: unknown,
  fallbackMsgId: string,
): { segmentId: string; content: string; thoughtContent: string } {
  if (err instanceof PipeEventsError) {
    return {
      segmentId: err.segmentId,
      content: err.partialContent,
      thoughtContent: err.partialThought,
    };
  }
  return { segmentId: fallbackMsgId, content: '', thoughtContent: '' };
}

// Pulls the interrupt value directly off a thrown GraphInterrupt, unwrapping
// PipeEventsError if present. @langchain/langgraph's interrupt() embeds the
// value on the error itself when it throws (`new GraphInterrupt([{id, value}])`)
// — reading it here instead of re-querying checkpoint state via getState()
// avoids a race against that checkpoint's own write, which can come back
// empty on a thread's very first interrupt. See recoverThrownInterrupt.
function extractInterruptFromError(err: unknown): { value: unknown } | undefined {
  const source = err instanceof PipeEventsError ? err.sourceError : err;
  return (source as { interrupts?: { value: unknown }[] } | undefined)?.interrupts?.[0];
}

// Shared by every SSE-handler catch block that needs the raw failure text
// for endTrace()/failAssistant() — err is `unknown` in a catch clause.
export function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Exported for direct testing — the highest-risk piece of this module (does
// accumulation + tool-call bookkeeping wire correctly to the persistence
// layer) without needing a live LLM through the full getChatAgent() chain.
export async function pipeEvents(
  sink: SseWriter,
  msgId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eventStream: AsyncIterable<any>,
  threadStore: ThreadStore,
  threadId: string,
  sentAt: string,
  provider?: string | null,
  model?: string | null,
): Promise<{
  content: string;
  thoughtContent: string;
  finalSegmentId: string;
  hadToolCall: boolean;
}> {
  const parse: ParseState = { inThought: false, buf: '', content: '', thought: '' };
  // updateMessage() replaces payload wholesale rather than merging, so
  // finalizeToolCall needs the original toolName/inputs back — tracked here
  // for the lifetime of this one turn.
  const toolCallsInFlight = new Map<
    string,
    { toolName: string; inputs: Record<string, unknown> }
  >();
  // Whether any tool call (including ask_user, excluded from the recording
  // below) fired during this turn — lets finalizeTurn tell "the model
  // legitimately said nothing because it only called a tool/asked the user
  // something" apart from a genuinely empty response. See finalizeTurn's
  // Ollama empty-response check.
  let hadToolCall = false;

  // Mirrors use-thread.ts's `_toolCallPendingSinceLastText` client-side
  // continuation logic: once a tool call starts, the next real text opens a
  // new assistant row instead of appending onto text written before the
  // tool call, so a reload's seq ordering matches what the live client
  // already showed instead of collapsing a whole turn's text into one row
  // that always sorts ahead of its own tool calls.
  let currentSegmentId = msgId;
  let toolCallPendingSinceLastText = false;

  try {
    for await (const evt of eventStream) {
      switch (evt.event) {
        case 'on_chat_model_stream': {
          const content = evt.data?.chunk?.content;
          if (typeof content === 'string' && content.length > 0) {
            if (toolCallPendingSinceLastText && parse.content.length > 0) {
              // flushDelta withholds a SAFE_MARGIN-sized tail in parse.buf in
              // case it's a split tag boundary — drain it (using the OLD
              // segment id) before closing that segment out, or it leaks
              // into the new segment's content the next time the buffer
              // flushes.
              drainBuffer(sink, currentSegmentId, parse);
              finalizeAssistant(
                threadStore,
                threadId,
                currentSegmentId,
                parse.content,
                parse.thought,
                sentAt,
                null,
              );
              const newSegmentId = randomUUID();
              recordAssistantStart(threadStore, threadId, newSegmentId, sentAt, provider, model);
              currentSegmentId = newSegmentId;
              parse.content = '';
              parse.thought = '';
            }
            toolCallPendingSinceLastText = false;
            flushDelta(sink, currentSegmentId, parse, content);
          }
          break;
        }

        case 'on_tool_start': {
          hadToolCall = true;
          if (evt.name !== 'ask_user') {
            const toolCallId = evt.run_id as string;
            const toolName = evt.name as string;
            const inputs = (evt.data?.input ?? {}) as Record<string, unknown>;
            toolCallsInFlight.set(toolCallId, { toolName, inputs });
            const seq = recordToolCallStart(threadStore, threadId, toolCallId, toolName, inputs);
            writeSseEvent(sink, {
              type: 'tool_call_start',
              messageId: randomUUID(),
              toolCallId,
              toolName,
              inputs,
              ...(seq !== null ? { seq } : {}),
            });
            toolCallPendingSinceLastText = true;
          }
          break;
        }

        case 'on_tool_end': {
          if (evt.name !== 'ask_user') {
            const toolCallId = evt.run_id as string;
            const outputs = extractToolResultContent(evt.data?.output);
            const started = toolCallsInFlight.get(toolCallId);
            if (started) {
              finalizeToolCall(
                threadStore,
                threadId,
                toolCallId,
                started.toolName,
                started.inputs,
                outputs,
              );
            }
            writeSseEvent(sink, {
              type: 'tool_call_end',
              toolCallId,
              outputs,
            });
          }
          break;
        }
      }
    }
  } catch (err) {
    throw new PipeEventsError(err, currentSegmentId, parse.content, parse.thought);
  }

  drainBuffer(sink, currentSegmentId, parse);
  return {
    content: parse.content,
    thoughtContent: parse.thought,
    finalSegmentId: currentSegmentId,
    hadToolCall,
  };
}

// ---- Finalize the assistant row, then emit either a HITL prompt or done ----

// Structural interface — any LangGraph-based agent satisfies this.
interface AgentWithGraph {
  graph: Pick<ChatAgent['graph'], 'getState'>;
}

// Given an interrupt already sitting in checkpoint state, persists a
// kind-appropriate hitl_prompt row (shell_approval / recursion_limit_warning
// / ask_user's yes_no|multiple_choice|free_text) and emits the matching live
// `hitl_prompt` SSE event. On failure to persist, marks the assistant row
// `msgId` as errored and emits `stream_error` — callers must treat a
// `{interrupted: false}` return as a real failure, never a waiting_on_user
// state. Shared by finalizeTurn's graceful (stream-completed-normally) path
// below and by task-execution.ts's GraphInterrupt catch branch, which
// recovers an interrupt LangGraph left parked in checkpoint state after
// pipeEvents throws instead of completing normally — see that file's own
// comment on why a thrown interrupt needs the same handling as a returned one.
// Why a HITL prompt failed to reach a real waiting_on_user state — surfaced
// all the way up through recoverThrownInterrupt to task-execution.ts, which
// puts it in the task's queue summary (and hence the Kanban board's
// reason.summary) instead of one generic string for two different causes.
export type HitlDispatchFailureReason = 'no_interrupt_in_state' | 'persist_failed';

export interface HitlDispatchResult {
  interrupted: boolean;
  reason?: HitlDispatchFailureReason;
  detail?: string;
}

export function dispatchHitlPrompt(
  sink: SseWriter,
  threadStore: ThreadStore,
  threadId: string,
  msgId: string,
  interrupt: { value: unknown },
  content: string,
  turnSentAt: string,
  assistantSeq: number | null,
  userSeq: number | null,
  taskId?: string,
): HitlDispatchResult {
  const interruptValue = interrupt.value as Record<string, unknown>;
  const promptId = randomUUID();

  try {
    if (interruptValue.kind === 'shell_approval') {
      const { command, reason } = interruptValue as { command: string; reason?: string };
      const question = 'Approve command execution?';
      const seq = recordHitlPrompt(threadStore, threadId, promptId, {
        question,
        promptKind: 'shell_approval',
        command,
        reason,
        ...(taskId ? { taskId } : {}),
      });
      writeSseEvent(sink, {
        type: 'hitl_prompt',
        messageId: msgId,
        promptId,
        question,
        kind: 'shell_approval',
        command,
        reason,
        seq,
        ...(assistantSeq !== null ? { assistantSeq } : {}),
        ...(userSeq !== null ? { userSeq } : {}),
      });
    } else if (interruptValue.kind === 'recursion_limit_warning') {
      const { question, choices, stepsUsed, recursionLimit } = interruptValue as {
        question: string;
        choices: string[];
        stepsUsed: number;
        recursionLimit: number;
      };
      const seq = recordHitlPrompt(threadStore, threadId, promptId, {
        question,
        promptKind: 'multiple_choice',
        choices,
        allowFreeText: true,
        stepsUsed,
        recursionLimit,
        ...(taskId ? { taskId } : {}),
      });
      writeSseEvent(sink, {
        type: 'hitl_prompt',
        messageId: msgId,
        promptId,
        question,
        kind: 'multiple_choice',
        choices,
        allowFreeText: true,
        stepsUsed,
        recursionLimit,
        seq,
        ...(assistantSeq !== null ? { assistantSeq } : {}),
        ...(userSeq !== null ? { userSeq } : {}),
      });
    } else if (interruptValue.kind === 'loop_stagnation_warning') {
      const { question, choices, summary } = interruptValue as {
        question: string;
        choices: string[];
        summary: string;
      };
      const seq = recordHitlPrompt(threadStore, threadId, promptId, {
        question,
        promptKind: 'multiple_choice',
        choices,
        allowFreeText: true,
        summary,
        ...(taskId ? { taskId } : {}),
      });
      writeSseEvent(sink, {
        type: 'hitl_prompt',
        messageId: msgId,
        promptId,
        question,
        kind: 'multiple_choice',
        choices,
        allowFreeText: true,
        summary,
        seq,
        ...(assistantSeq !== null ? { assistantSeq } : {}),
        ...(userSeq !== null ? { userSeq } : {}),
      });
    } else {
      const { question, kind, choices, allowFreeText, approveLabel, approveType, rejectLabel } =
        interruptValue as {
          question: string;
          kind: 'yes_no' | 'multiple_choice' | 'free_text';
          choices?: string[];
          allowFreeText?: boolean;
          approveLabel?: string;
          approveType?: 'primary' | 'secondary' | 'destructive';
          rejectLabel?: string;
        };
      const seq = recordHitlPrompt(threadStore, threadId, promptId, {
        question,
        promptKind: kind,
        choices,
        allowFreeText,
        approveLabel,
        approveType,
        rejectLabel,
        ...(taskId ? { taskId } : {}),
      });
      writeSseEvent(sink, {
        type: 'hitl_prompt',
        messageId: msgId,
        promptId,
        question,
        kind,
        choices,
        allowFreeText,
        approveLabel,
        approveType,
        rejectLabel,
        seq,
        ...(assistantSeq !== null ? { assistantSeq } : {}),
        ...(userSeq !== null ? { userSeq } : {}),
      });
    }
  } catch (err) {
    logger.error('dispatchHitlPrompt: failed to persist HITL prompt', {
      threadId,
      err: serializeError(err),
    });
    failAssistant(threadStore, threadId, msgId, content, turnSentAt);
    writeSseEvent(sink, { type: 'stream_error', error: 'Failed to save approval prompt' });
    // The interrupt could not be durably recorded, so there is no prompt
    // for the user to ever answer — a caller must treat this as a plain
    // failure, not a real waiting_on_user state.
    return { interrupted: false, reason: 'persist_failed', detail: errorMessageOf(err) };
  }
  return { interrupted: true };
}

// Recovers a GraphInterrupt thrown mid-stream — LangGraph's own interrupt()
// control-flow signal, which pipeEvents forwards as a PipeEventsError
// preserving `.name` (see that class's own comment) — the same way the
// graceful, stream-completed-normally path above already does: finalize
// whatever partial content streamed before the throw, then read the
// interrupt value directly off the caught error (extractInterruptFromError)
// and dispatch it via dispatchHitlPrompt. Returns null when `err` isn't a
// GraphInterrupt at all, so the caller's own catch block falls through to
// its existing error handling unchanged. Every turn handler that calls
// pipeEvents/finalizeTurn (chat, workspace chat, wiki chat, task execution,
// headless notification turns) binds shell_exec and is exposed to this same
// failure mode, so this is the one place that recovery logic is written.
export async function recoverThrownInterrupt(
  err: unknown,
  sink: SseWriter,
  threadStore: ThreadStore,
  threadId: string,
  msgId: string,
  turnSentAt: string,
  assistantSeq: number | null,
  userSeq: number | null,
  taskId?: string,
): Promise<HitlDispatchResult | null> {
  if ((err as Error)?.name !== 'GraphInterrupt') return null;

  const partialState = extractPartialAssistantState(err, msgId);
  finalizeAssistant(
    threadStore,
    threadId,
    partialState.segmentId,
    partialState.content,
    partialState.thoughtContent,
    turnSentAt,
    null,
  );

  const interrupt = extractInterruptFromError(err);
  if (!interrupt) {
    // Name matched but the error itself carried no interrupts — safety net,
    // not the expected path (interrupt() always sets this). Logged (unlike
    // a normal handled case) since this means something produced a
    // GraphInterrupt-named error outside the normal interrupt() path.
    logger.error('recoverThrownInterrupt: no interrupts found on the caught GraphInterrupt', {
      threadId,
      err: serializeError(err),
    });
    failAssistant(
      threadStore,
      threadId,
      partialState.segmentId,
      partialState.content,
      turnSentAt,
      partialState.thoughtContent,
      'Lost the approval prompt after an interrupt.',
      'unknown',
    );
    return { interrupted: false, reason: 'no_interrupt_in_state' };
  }

  return dispatchHitlPrompt(
    sink,
    threadStore,
    threadId,
    partialState.segmentId,
    interrupt as { value: unknown },
    partialState.content,
    turnSentAt,
    assistantSeq,
    userSeq,
    taskId,
  );
}

export async function finalizeTurn(
  sink: SseWriter,
  threadStore: ThreadStore,
  agent: AgentWithGraph,
  threadId: string,
  msgId: string,
  startedAt: number,
  content: string,
  thoughtContent: string,
  // Whether pipeEvents observed any tool call during this turn — see its
  // own hadToolCall comment. Used below to tell a legitimately empty
  // response (the model only called a tool/asked the user something) apart
  // from Ollama silently returning nothing on context overflow.
  hadToolCall: boolean,
  turnSentAt: string,
  assistantSeq: number | null,
  userSeq: number | null,
  obsHandler?: {
    totalInputTokens: number;
    totalOutputTokens: number;
    turnDurationMs: number;
    lastContextWindowInputTokens: number;
  },
  effectiveProvider?: string,
  effectiveModel?: string,
  // Set only when this turn belongs to an automated task run (task-execution.ts)
  // — threaded into the hitl_prompt payload so the /hitl route can tell a
  // task-originated prompt apart from a plain chat one and re-enqueue instead
  // of resuming an interactive turn. Existing callers omit it; behavior is
  // unchanged for them.
  taskId?: string,
  // Set only by task-execution.ts, only when complete_task already fired
  // earlier in this same stream (see tapCompleteTask/completeTaskBox there).
  // agent.graph.getState() reads state for the whole shared thread, not just
  // this run, so it can still report a pending interrupt here even though
  // the task itself is already finished — e.g. the model does one more
  // tool call needing approval right after calling complete_task. Since
  // task-execution.ts always gives completeTaskBox priority over
  // `interrupted` once both are true, dispatching that interrupt as a live
  // hitl_prompt would durably show the user a prompt with no queue row ever
  // able to back it (parkQueueEntryForHitl is only reached on the
  // `interrupted`-wins branch) — exactly what let a later, stale /hitl
  // answer silently re-run an already-completed task. Discarding it here,
  // before it's ever written or shown, is what keeps that queue row's
  // completion the only thing task-execution.ts has to reconcile.
  discardInterrupt = false,
  // Per-attachment outcomes this turn resolved — only the three main-turn
  // callers (streamChatToSse and its workspace/wiki siblings) ever have
  // any; resume/retry/headless/task callers never resolve attachments and
  // leave this undefined. Included on every stream_done write below so the
  // live UI can patch the optimistic bubble without a reload.
  attachments?: UserMessageAttachment[],
): Promise<{ interrupted: boolean }> {
  const durationMs = Date.now() - startedAt;
  const config = { configurable: { thread_id: threadId } };
  const state = await agent.graph.getState(config);
  const checkpointId = (state.config.configurable?.checkpoint_id as string | undefined) ?? null;

  let metrics: AssistantMetrics | undefined;

  if (obsHandler) {
    const inputTokens = obsHandler.totalInputTokens;
    const outputTokens = obsHandler.totalOutputTokens;
    const obsDurationMs = obsHandler.turnDurationMs;
    const tps =
      obsDurationMs > 0
        ? Math.round((outputTokens / (obsDurationMs / 1000)) * 100) / 100
        : undefined;
    const contextWindowLimit = env.chat.contextWindow?.maxTokens ?? 32000;
    const cwTokens =
      obsHandler.lastContextWindowInputTokens > 0
        ? obsHandler.lastContextWindowInputTokens
        : undefined;
    const cwPct =
      cwTokens !== undefined
        ? Math.round((cwTokens / contextWindowLimit) * 10000) / 100
        : undefined;

    const providerKey =
      effectiveProvider && effectiveModel ? `${effectiveProvider}/${effectiveModel}` : null;
    const rates = providerKey ? env.costs[providerKey] : undefined;
    const estimatedCostUsd = rates
      ? (inputTokens / 1000) * rates.inputPer1kTokens +
        (outputTokens / 1000) * rates.outputPer1kTokens
      : undefined;

    metrics = {
      durationMs,
      usage: { inputTokens, outputTokens },
      ...(tps !== undefined || estimatedCostUsd !== undefined
        ? {
            cost: {
              ...(tps !== undefined ? { tokensPerSecond: tps } : {}),
              ...(estimatedCostUsd !== undefined ? { dollars: estimatedCostUsd } : {}),
            },
          }
        : {}),
    };

    writeSseEvent(sink, {
      type: 'usage_stats',
      messageId: msgId,
      inputTokens,
      outputTokens,
      ...(tps !== undefined ? { tokensPerSecond: tps } : {}),
      ...(cwTokens !== undefined ? { contextWindowTokens: cwTokens } : {}),
      contextWindowLimit,
      ...(cwPct !== undefined ? { contextUtilizationPct: cwPct } : {}),
      ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
    });
  }

  finalizeAssistant(
    threadStore,
    threadId,
    msgId,
    content,
    thoughtContent,
    turnSentAt,
    checkpointId,
    metrics,
  );

  const interrupt = state.tasks?.[0]?.interrupts?.[0];

  if (interrupt && discardInterrupt) {
    logger.warn(
      'finalizeTurn: discarding a pending interrupt found after complete_task already ' +
        'completed this run — no hitl_prompt will be dispatched for it',
      { threadId, taskId },
    );
  }

  if (interrupt && !discardInterrupt) {
    return dispatchHitlPrompt(
      sink,
      threadStore,
      threadId,
      msgId,
      // LangGraph's own Interrupt type carries more than { value: unknown }
      // (id, resumable, etc.) — dispatchHitlPrompt only ever reads .value,
      // so it declares the narrower structural shape it actually needs.
      interrupt as { value: unknown },
      content,
      turnSentAt,
      assistantSeq,
      userSeq,
      taskId,
    );
  } else {
    // Ollama can silently truncate/return nothing when the context window is
    // exceeded, rather than throwing — this heuristic re-routes that case
    // into the same failure path a thrown error takes. Scoped to Ollama and
    // to a truly empty turn (no tool call, including ask_user, and no
    // thought content either) so a legitimate tool-only or thinking-only
    // turn is never misclassified. See
    // docs/superpowers/specs/2026-09-08-chat-error-classification-design.md §4e.
    if (
      effectiveProvider === 'ollama' &&
      content.trim() === '' &&
      thoughtContent.trim() === '' &&
      !hadToolCall
    ) {
      const emptyResponseMessage =
        'Ollama returned an empty response — this usually happens when the context window was exceeded.';
      failAssistant(
        threadStore,
        threadId,
        msgId,
        content,
        turnSentAt,
        undefined,
        emptyResponseMessage,
        'context_length',
      );
      writeSseEvent(sink, {
        type: 'stream_error',
        error: emptyResponseMessage,
        errorCategory: 'context_length',
        ...(attachments?.length ? { attachments } : {}),
      });
      return { interrupted: false };
    }

    writeSseEvent(sink, {
      type: 'stream_done',
      durationMs,
      ...(assistantSeq !== null ? { assistantSeq } : {}),
      ...(userSeq !== null ? { userSeq } : {}),
      ...(attachments?.length ? { attachments } : {}),
    });
    return { interrupted: false };
  }
}

export function drainAndRecordWikiUpdates(
  sink: SseWriter,
  threadStore: ThreadStore,
  threadId: string,
): void {
  for (const event of drainPendingWikiUpdates(threadId)) {
    if (event.type === 'wiki_updated') {
      const seq = recordWikiUpdate(
        threadStore,
        threadId,
        randomUUID(),
        event.pageTitle,
        event.pageKind,
        event.wikiName,
        event.path,
      );
      writeSseEvent(sink, seq !== null ? { ...event, seq } : event);
    } else {
      writeSseEvent(sink, event);
    }
  }
}

// Live, in-turn SSE events (as opposed to drainAndRecordWikiUpdates' deferred
// after-agent queue above) go through this writer. Most event types are a
// pure passthrough, but resource_created also needs a thread_messages row —
// unlike wiki_domain_created, which only ever streams live and is never
// persisted — so the persisting write happens here rather than tripling this
// branch across the three setActiveSseWriter call sites below.
export function makeLiveSseWriter(
  res: Response,
  threadStore: ThreadStore,
  threadId: string,
): SseWriter {
  const rawWrite: SseWriter = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  return (event: ChatSSEEvent) => {
    if (event.type === 'resource_created') {
      const seq = recordResourceCard(
        threadStore,
        threadId,
        randomUUID(),
        event.resourceType,
        event.name,
        event.goal,
        event.location,
        event.workspaceId,
      );
      rawWrite(seq !== null ? { ...event, seq } : event);
      return;
    }
    rawWrite(event);
  };
}

// ---- Public handlers ----

// Test-only seam — mirrors task-execution.ts's ExecuteTaskDeps: getChatAgent()
// caches a real agent built against a real provider, which a unit test
// driving a fake aborting event stream cannot exercise directly. Defaults to
// the real implementation everywhere except tests.
export interface ChatStreamDeps {
  getChatAgent?: typeof getChatAgent;
}

// Another turn currently owns this thread — a headless wake-up or sub-agent
// notification turn, or another tab's chat turn. Refuse rather than race a
// second agent.streamEvents() against the same LangGraph checkpoint. Same
// SSE stream_error shape workspace chat uses
// (workspace-chat-stream-handler.ts). Returns true when the turn was refused.
export const THREAD_BUSY_MESSAGE = 'This chat is busy with another turn — try again in a moment.';

function refuseIfThreadBusy(res: Response, threadId: string): boolean {
  if (!getActiveSseWriter(threadId)) return false;
  writeSseEvent((event) => res.write(`data: ${JSON.stringify(event)}\n\n`), {
    type: 'stream_error',
    error: THREAD_BUSY_MESSAGE,
  });
  return true;
}

export async function streamChatToSse(
  res: Response,
  threadId: string,
  content: string,
  startedAt: number,
  provider?: string,
  model?: string,
  afterAgent?: boolean,
  attachmentIds?: string[],
  deps: ChatStreamDeps = {},
): Promise<void> {
  if (refuseIfThreadBusy(res, threadId)) return;
  const resolveChatAgent = deps.getChatAgent ?? getChatAgent;
  const threadStore = getThreadStore();
  threadStore.upsertThreadOnFirstMessage(threadId, content.slice(0, 50), 'chat');

  const threadMeta = threadStore.getThreadMeta(threadId);
  const effectiveProvider = provider ?? threadMeta?.provider ?? undefined;
  const effectiveModel = model ?? threadMeta?.model ?? undefined;
  if (provider !== undefined || model !== undefined) {
    threadStore.updateThreadModel(threadId, effectiveProvider ?? null, effectiveModel ?? null);
  }

  const { agent, systemPrompt } = await resolveChatAgent(effectiveProvider, effectiveModel);
  const providerConfig = resolveProviderConfig(effectiveProvider);
  const { provider: resolvedProvider, model: resolvedModel } = resolveTurnModel(
    effectiveProvider,
    effectiveModel,
  );
  const msgId = randomUUID();
  const turnSentAt = new Date().toISOString();
  const sink = makeLiveSseWriter(res, threadStore, threadId);

  const { records: attachmentRecords, injections: attachmentInjections } =
    await resolveAttachmentsForTurn(
      attachmentIds ?? [],
      threadId,
      effectiveProvider,
      effectiveModel,
    );
  const turnAttachments = attachmentRecords.length ? attachmentRecords : undefined;
  const config = {
    configurable: { thread_id: threadId, attachmentInjections },
  };

  const userSeq = recordUserMessage(
    threadStore,
    threadId,
    randomUUID(),
    content,
    turnSentAt,
    turnAttachments,
  );
  // Regardless of whether an attachment ended up included or excluded —
  // an excluded attachment was still resolved by this send, not
  // abandoned, so it must not be swept by the orphaned-upload GC.
  for (const record of attachmentRecords) await markArtifactReferenced(record.id);

  drainAndRecordWikiUpdates(sink, threadStore, threadId);

  const turnObs = startTurnObservability({
    threadId,
    provider: resolvedProvider,
    model: resolvedModel,
    source: 'chat',
    systemPrompt,
  });

  // Documents, outside the live SSE stream and the chip UI, whether each of
  // this turn's attachments actually reached the model and why not when it
  // didn't — see docs/superpowers/specs/2026-10-02-chat-attachment-fixes-design.md §6.
  if (attachmentRecords.length) {
    getObservabilityStore().saveSpans(
      attachmentRecords.map((record) => buildAttachmentSpan(turnObs.traceId, turnSentAt, record)),
    );
  }

  const assistantSeq = recordAssistantStart(
    threadStore,
    threadId,
    msgId,
    turnSentAt,
    resolvedProvider,
    resolvedModel,
  );

  const controller = new AbortController();
  setActiveSseWriter(threadId, sink, controller);
  let turnError: string | null = null;
  try {
    const {
      content: finalContent,
      thoughtContent,
      finalSegmentId,
      hadToolCall,
    } = await getProviderQueue().withSlot(
      resolvedProvider,
      'sync',
      async () => {
        const eventStream = agent.streamEvents(
          { messages: [{ role: 'human', content }] },
          turnObs.attach({
            ...config,
            version: 'v2',
            context: {
              provider: effectiveProvider ?? env.defaultProvider,
              // Left as `effectiveModel` (not `effectiveModel ?? ''`) so an unset
              // model stays undefined — AfterAgent reads this straight into
              // createProvider(provider, model), where `'' ?? config.defaultModel`
              // would resolve to '' (not nullish) instead of the provider default.
              model: effectiveModel,
              afterAgentEnabled: afterAgent,
            },
            recursionLimit: env.agent?.recursionLimit ?? 100,
            signal: controller.signal,
          }),
        );

        return pipeEvents(
          sink,
          msgId,
          eventStream,
          threadStore,
          threadId,
          turnSentAt,
          effectiveProvider,
          effectiveModel,
        );
      },
      {
        onWaitChange: (waiting) =>
          writeSseEvent(sink, { type: 'provider_wait', provider: resolvedProvider, waiting }),
        signal: controller.signal,
      },
    );

    await finalizeTurn(
      sink,
      threadStore,
      agent,
      threadId,
      finalSegmentId,
      startedAt,
      finalContent,
      thoughtContent,
      hadToolCall,
      turnSentAt,
      assistantSeq,
      userSeq,
      turnObs.obsHandler,
      resolvedProvider,
      resolvedModel,
      undefined,
      false,
      turnAttachments,
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
      userSeq,
    );
    if (recovered) return;

    const {
      segmentId,
      content: partialContent,
      thoughtContent: partialThought,
    } = extractPartialAssistantState(err, msgId);
    if (controller.signal.aborted) {
      turnError = 'Stopped.';
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
      throw new ClassifiedTurnError('Stopped.', 'cancelled', turnAttachments);
    }
    if ((err as Error).name === 'GraphRecursionError') {
      const msg =
        'I ran out of steps before finishing. You can reply with instructions to continue, or ask me to summarize what I accomplished so far.';
      finalizeAssistant(threadStore, threadId, segmentId, msg, '', turnSentAt, null);
      writeSseEvent(sink, { type: 'text_delta', messageId: segmentId, delta: msg });
      writeSseEvent(sink, {
        type: 'stream_done',
        durationMs: Date.now() - startedAt,
        ...(turnAttachments ? { attachments: turnAttachments } : {}),
      });
      return;
    }
    const classified = classifyChatError(err, providerConfig.type);
    turnError = classified.message;
    failAssistant(
      threadStore,
      threadId,
      segmentId,
      partialContent,
      turnSentAt,
      partialThought,
      turnError,
      classified.category,
    );
    throw new ClassifiedTurnError(classified.message, classified.category, turnAttachments);
  } finally {
    await turnObs.end(turnError);
    endThreadTurn(threadId);
  }
}

export async function resumeChatToSse(
  res: Response,
  threadId: string,
  promptId: string,
  answer: string,
  startedAt: number,
  provider?: string,
  model?: string,
  afterAgent?: boolean,
  deps: ChatStreamDeps = {},
): Promise<void> {
  if (refuseIfThreadBusy(res, threadId)) return;
  const resolveChatAgent = deps.getChatAgent ?? getChatAgent;
  const threadStore = getThreadStore();

  const threadMeta = threadStore.getThreadMeta(threadId);
  const effectiveProvider = provider ?? threadMeta?.provider ?? undefined;
  const effectiveModel = model ?? threadMeta?.model ?? undefined;
  if (provider !== undefined || model !== undefined) {
    threadStore.updateThreadModel(threadId, effectiveProvider ?? null, effectiveModel ?? null);
  }

  const { agent, systemPrompt } = await resolveChatAgent(effectiveProvider, effectiveModel);
  const providerConfig = resolveProviderConfig(effectiveProvider);
  const { provider: resolvedProvider, model: resolvedModel } = resolveTurnModel(
    effectiveProvider,
    effectiveModel,
  );
  const config = { configurable: { thread_id: threadId } };
  const msgId = randomUUID();
  const turnSentAt = new Date().toISOString();
  const sink = makeLiveSseWriter(res, threadStore, threadId);

  try {
    resolveHitlPrompt(threadStore, threadId, promptId, answer);
  } catch (err) {
    logger.error('resumeChatToSse: failed to resolve HITL prompt', {
      threadId,
      promptId,
      err: serializeError(err),
    });
    writeSseEvent(sink, { type: 'stream_error', error: 'Failed to record HITL answer' });
    return;
  }

  drainAndRecordWikiUpdates(sink, threadStore, threadId);

  const turnObs = startTurnObservability({
    threadId,
    provider: resolvedProvider,
    model: resolvedModel,
    source: 'chat',
    systemPrompt,
  });

  const assistantSeq = recordAssistantStart(
    threadStore,
    threadId,
    msgId,
    turnSentAt,
    resolvedProvider,
    resolvedModel,
  );

  const controller = new AbortController();
  setActiveSseWriter(threadId, sink, controller);
  let turnError: string | null = null;
  try {
    const {
      content: finalContent,
      thoughtContent,
      finalSegmentId,
      hadToolCall,
    } = await getProviderQueue().withSlot(
      resolvedProvider,
      'sync',
      async () => {
        const eventStream = agent.streamEvents(
          new Command({ resume: answer }),
          turnObs.attach({
            ...config,
            version: 'v2',
            recursionLimit: env.agent?.recursionLimit ?? 100,
            context: {
              provider: effectiveProvider ?? env.defaultProvider,
              // See streamChatToSse's comment — must stay `effectiveModel`, not `effectiveModel ?? ''`.
              model: effectiveModel,
              afterAgentEnabled: afterAgent,
            },
            signal: controller.signal,
          }),
        );

        return pipeEvents(
          sink,
          msgId,
          eventStream,
          threadStore,
          threadId,
          turnSentAt,
          effectiveProvider,
          effectiveModel,
        );
      },
      {
        onWaitChange: (waiting) =>
          writeSseEvent(sink, { type: 'provider_wait', provider: resolvedProvider, waiting }),
        signal: controller.signal,
      },
    );

    await finalizeTurn(
      sink,
      threadStore,
      agent,
      threadId,
      finalSegmentId,
      startedAt,
      finalContent,
      thoughtContent,
      hadToolCall,
      turnSentAt,
      assistantSeq,
      null,
      turnObs.obsHandler,
      resolvedProvider,
      resolvedModel,
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
    );
    if (recovered) return;

    const {
      segmentId,
      content: partialContent,
      thoughtContent: partialThought,
    } = extractPartialAssistantState(err, msgId);
    if (controller.signal.aborted) {
      turnError = 'Stopped.';
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
      throw new ClassifiedTurnError('Stopped.', 'cancelled');
    }
    if ((err as Error).name === 'GraphRecursionError') {
      const msg =
        'I ran out of steps before finishing. You can reply with instructions to continue, or ask me to summarize what I accomplished so far.';
      finalizeAssistant(threadStore, threadId, segmentId, msg, '', turnSentAt, null);
      writeSseEvent(sink, { type: 'text_delta', messageId: segmentId, delta: msg });
      writeSseEvent(sink, { type: 'stream_done', durationMs: Date.now() - startedAt });
      return;
    }
    const classified = classifyChatError(err, providerConfig.type);
    turnError = classified.message;
    failAssistant(
      threadStore,
      threadId,
      segmentId,
      partialContent,
      turnSentAt,
      partialThought,
      turnError,
      classified.category,
    );
    throw new ClassifiedTurnError(classified.message, classified.category);
  } finally {
    await turnObs.end(turnError);
    endThreadTurn(threadId);
  }
}

// Retries the thread's last turn if it failed — see
// docs/Design/2026-07-18-persistent-conversation-memory-design.md's "Turn
// Failure & Retry". Distinct from resumeChatToSse: HITL resume supplies a
// value to a paused interrupt() via Command({resume}); retry recovers from
// an uncaught exception by re-invoking with no new input at all, which
// LangGraph resumes from the last successfully checkpointed step (confirmed
// against the real agent — see the design doc's "Retry mechanics").
export async function retryChatToSse(
  res: Response,
  threadId: string,
  startedAt: number,
  provider?: string,
  model?: string,
  afterAgent?: boolean,
  deps: ChatStreamDeps = {},
): Promise<void> {
  if (refuseIfThreadBusy(res, threadId)) return;
  const resolveChatAgent = deps.getChatAgent ?? getChatAgent;
  const threadStore = getThreadStore();

  const threadMeta = threadStore.getThreadMeta(threadId);
  const effectiveProvider = provider ?? threadMeta?.provider ?? undefined;
  const effectiveModel = model ?? threadMeta?.model ?? undefined;
  if (provider !== undefined || model !== undefined) {
    threadStore.updateThreadModel(threadId, effectiveProvider ?? null, effectiveModel ?? null);
  }

  const { agent, systemPrompt } = await resolveChatAgent(effectiveProvider, effectiveModel);
  const providerConfig = resolveProviderConfig(effectiveProvider);
  const { provider: resolvedProvider, model: resolvedModel } = resolveTurnModel(
    effectiveProvider,
    effectiveModel,
  );
  const config = { configurable: { thread_id: threadId } };

  const failedId = threadStore.resolveRetryTarget(threadId);
  if (!failedId) {
    throw new Error(`Thread "${threadId}" has no retryable (failed) turn`);
  }

  const msgId = randomUUID();
  const turnSentAt = new Date().toISOString();
  const assistantSeq = recordRetryAttempt(
    threadStore,
    threadId,
    msgId,
    failedId,
    turnSentAt,
    resolvedProvider,
    resolvedModel,
  );

  const sink = makeLiveSseWriter(res, threadStore, threadId);
  drainAndRecordWikiUpdates(sink, threadStore, threadId);

  const turnObs = startTurnObservability({
    threadId,
    provider: resolvedProvider,
    model: resolvedModel,
    source: 'chat',
    systemPrompt,
  });

  const controller = new AbortController();
  setActiveSseWriter(threadId, sink, controller);
  let turnError: string | null = null;
  try {
    const {
      content: finalContent,
      thoughtContent,
      finalSegmentId,
      hadToolCall,
    } = await getProviderQueue().withSlot(
      resolvedProvider,
      'sync',
      async () => {
        const eventStream = agent.streamEvents(
          null,
          turnObs.attach({
            ...config,
            version: 'v2',
            recursionLimit: env.agent?.recursionLimit ?? 100,
            context: {
              provider: effectiveProvider ?? env.defaultProvider,
              // See streamChatToSse's comment — must stay `effectiveModel`, not `effectiveModel ?? ''`.
              model: effectiveModel,
              afterAgentEnabled: afterAgent,
            },
            signal: controller.signal,
          }),
        );

        return pipeEvents(
          sink,
          msgId,
          eventStream,
          threadStore,
          threadId,
          turnSentAt,
          effectiveProvider,
          effectiveModel,
        );
      },
      {
        onWaitChange: (waiting) =>
          writeSseEvent(sink, { type: 'provider_wait', provider: resolvedProvider, waiting }),
        signal: controller.signal,
      },
    );

    await finalizeTurn(
      sink,
      threadStore,
      agent,
      threadId,
      finalSegmentId,
      startedAt,
      finalContent,
      thoughtContent,
      hadToolCall,
      turnSentAt,
      assistantSeq,
      null,
      turnObs.obsHandler,
      resolvedProvider,
      resolvedModel,
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
    );
    if (recovered) return;

    const {
      segmentId,
      content: partialContent,
      thoughtContent: partialThought,
    } = extractPartialAssistantState(err, msgId);
    if (controller.signal.aborted) {
      turnError = 'Stopped.';
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
      throw new ClassifiedTurnError('Stopped.', 'cancelled');
    }
    if ((err as Error).name === 'GraphRecursionError') {
      const msg =
        'I ran out of steps before finishing. You can reply with instructions to continue, or ask me to summarize what I accomplished so far.';
      finalizeAssistant(threadStore, threadId, segmentId, msg, '', turnSentAt, null);
      writeSseEvent(sink, { type: 'text_delta', messageId: segmentId, delta: msg });
      writeSseEvent(sink, { type: 'stream_done', durationMs: Date.now() - startedAt });
      return;
    }
    const classified = classifyChatError(err, providerConfig.type);
    turnError = classified.message;
    failAssistant(
      threadStore,
      threadId,
      segmentId,
      partialContent,
      turnSentAt,
      partialThought,
      turnError,
      classified.category,
    );
    throw new ClassifiedTurnError(classified.message, classified.category);
  } finally {
    await turnObs.end(turnError);
    endThreadTurn(threadId);
  }
}
