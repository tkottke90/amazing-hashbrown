import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { Command } from '@langchain/langgraph';
import { logger, serializeError } from '../config/logger.js';
import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';
import { getChatAgent, type ChatAgent } from './chat-agent.js';
import { setActiveSseWriter, clearActiveSseWriter, type SseWriter } from './active-sse-writer.js';
import { env } from '../config/env.js';
import { getObservabilityStore } from '../services/observability.js';
import { getThreadStore, type ThreadStore } from '../services/thread-store.js';
import { getTaskScheduler } from '../services/task-scheduler.js';
import { ObservabilityCallbackHandler } from './observability-handler.js';
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
} from './thread-message-writer.js';
import { extractToolResultContent } from './tool-output.js';

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

  constructor(sourceErr: unknown, segmentId: string, partialContent: string, partialThought: string) {
    super(sourceErr instanceof Error ? sourceErr.message : String(sourceErr));
    // Preserve the original error's name (e.g. 'GraphRecursionError') so the
    // existing `(err as Error).name === 'GraphRecursionError'` checks below
    // (and in the wiki/workspace equivalents) keep working against this
    // wrapper without change.
    this.name = sourceErr instanceof Error ? sourceErr.name : 'PipeEventsError';
    this.segmentId = segmentId;
    this.partialContent = partialContent;
    this.partialThought = partialThought;
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
): Promise<{ content: string; thoughtContent: string; finalSegmentId: string }> {
  const parse: ParseState = { inThought: false, buf: '', content: '', thought: '' };
  // updateMessage() replaces payload wholesale rather than merging, so
  // finalizeToolCall needs the original toolName/inputs back — tracked here
  // for the lifetime of this one turn.
  const toolCallsInFlight = new Map<
    string,
    { toolName: string; inputs: Record<string, unknown> }
  >();

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
  };
}

// ---- Finalize the assistant row, then emit either a HITL prompt or done ----

// Structural interface — any LangGraph-based agent satisfies this.
interface AgentWithGraph {
  graph: Pick<ChatAgent['graph'], 'getState'>;
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
): Promise<{ interrupted: boolean }> {
  const config = { configurable: { thread_id: threadId } };
  const state = await agent.graph.getState(config);
  const checkpointId = (state.config.configurable?.checkpoint_id as string | undefined) ?? null;

  finalizeAssistant(
    threadStore,
    threadId,
    msgId,
    content,
    thoughtContent,
    turnSentAt,
    checkpointId,
  );

  if (obsHandler) {
    const inputTokens = obsHandler.totalInputTokens;
    const outputTokens = obsHandler.totalOutputTokens;
    const durationMs = obsHandler.turnDurationMs;
    const tps =
      durationMs > 0 ? Math.round((outputTokens / (durationMs / 1000)) * 100) / 100 : undefined;
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

  const interrupt = state.tasks?.[0]?.interrupts?.[0];

  if (interrupt) {
    const interruptValue = interrupt.value as Record<string, unknown>;
    const promptId = randomUUID();

    try {
      if (interruptValue.kind === 'shell_approval') {
        const { command, reason } = interruptValue as { command: string; reason?: string };
        const question = reason
          ? `Allow command: \`${command}\`\n\nReason: ${reason}`
          : `Allow command: \`${command}\``;
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
      logger.error('finalizeTurn: failed to persist HITL prompt', {
        threadId,
        err: serializeError(err),
      });
      failAssistant(threadStore, threadId, msgId, content, turnSentAt);
      writeSseEvent(sink, { type: 'stream_error', error: 'Failed to save approval prompt' });
      // The interrupt could not be durably recorded, so there is no prompt
      // for the user to ever answer — a caller must treat this as a plain
      // failure, not a real waiting_on_user state.
      return { interrupted: false };
    }
    return { interrupted: true };
  } else {
    writeSseEvent(sink, {
      type: 'stream_done',
      durationMs: Date.now() - startedAt,
      ...(assistantSeq !== null ? { assistantSeq } : {}),
      ...(userSeq !== null ? { userSeq } : {}),
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

export async function streamChatToSse(
  res: Response,
  threadId: string,
  content: string,
  startedAt: number,
  provider?: string,
  model?: string,
  afterAgent?: boolean,
): Promise<void> {
  // A chat message just came in — pause the task scheduler immediately so
  // background task work doesn't compete with this turn (issue #68). The
  // whole body runs inside a try/finally from here down so scheduleResume()
  // fires no matter where this fails — including getChatAgent() below,
  // which throws synchronously-ish on a misconfigured/unreachable provider,
  // well before the inner try/finally that used to be the only guard.
  getTaskScheduler().pause();
  try {
    const threadStore = getThreadStore();
    threadStore.upsertThreadOnFirstMessage(threadId, content.slice(0, 50), 'chat');

    const threadMeta = threadStore.getThreadMeta(threadId);
    const effectiveProvider = provider ?? threadMeta?.provider ?? undefined;
    const effectiveModel = model ?? threadMeta?.model ?? undefined;
    if (provider !== undefined || model !== undefined) {
      threadStore.updateThreadModel(threadId, effectiveProvider ?? null, effectiveModel ?? null);
    }

    const { agent, systemPrompt } = await getChatAgent(effectiveProvider, effectiveModel);
    const config = { configurable: { thread_id: threadId } };
    const msgId = randomUUID();
    const turnSentAt = new Date().toISOString();
    const sink = makeLiveSseWriter(res, threadStore, threadId);

    const userSeq = recordUserMessage(threadStore, threadId, randomUUID(), content, turnSentAt);

    drainAndRecordWikiUpdates(sink, threadStore, threadId);

    const obsConfig = env.observability;
    const store = getObservabilityStore();
    const traceId = store.startTrace({
      threadId,
      provider: effectiveProvider ?? env.defaultProvider,
      model: effectiveModel ?? '',
      source: 'chat',
      systemPrompt,
    });
    const obsHandler = new ObservabilityCallbackHandler(
      traceId,
      store,
      obsConfig.spanOutputPreviewChars,
    );

    const assistantSeq = recordAssistantStart(
      threadStore,
      threadId,
      msgId,
      turnSentAt,
      effectiveProvider,
      effectiveModel,
    );

    setActiveSseWriter(threadId, sink);
    try {
      const eventStream = agent.streamEvents(
        { messages: [{ role: 'human', content }] },
        {
          ...config,
          version: 'v2',
          callbacks: [obsHandler],
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
        },
      );

      const {
        content: finalContent,
        thoughtContent,
        finalSegmentId,
      } = await pipeEvents(
        sink,
        msgId,
        eventStream,
        threadStore,
        threadId,
        turnSentAt,
        effectiveProvider,
        effectiveModel,
      );

      store.endTrace(traceId, {
        totalTokens: obsHandler.totalInputTokens + obsHandler.totalOutputTokens,
      });

      await finalizeTurn(
        sink,
        threadStore,
        agent,
        threadId,
        finalSegmentId,
        startedAt,
        finalContent,
        thoughtContent,
        turnSentAt,
        assistantSeq,
        userSeq,
        obsHandler,
        effectiveProvider,
        effectiveModel,
      );
    } catch (err) {
      const {
        segmentId,
        content: partialContent,
        thoughtContent: partialThought,
      } = extractPartialAssistantState(err, msgId);
      if ((err as Error).name === 'GraphRecursionError') {
        const msg =
          'I ran out of steps before finishing. You can reply with instructions to continue, or ask me to summarize what I accomplished so far.';
        finalizeAssistant(threadStore, threadId, segmentId, msg, '', turnSentAt, null);
        writeSseEvent(sink, { type: 'text_delta', messageId: segmentId, delta: msg });
        writeSseEvent(sink, { type: 'stream_done', durationMs: Date.now() - startedAt });
        return;
      }
      failAssistant(threadStore, threadId, segmentId, partialContent, turnSentAt, partialThought);
      throw err;
    } finally {
      clearActiveSseWriter(threadId);
    }
  } finally {
    // Response fully sent (or the turn failed outright) — arm the 30s idle
    // timer. A message arriving before it fires calls pause() again, which
    // clears and effectively resets it.
    getTaskScheduler().scheduleResume();
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
): Promise<void> {
  // See streamChatToSse's comment: the whole body runs inside a
  // try/finally from here down so scheduleResume() fires no matter where
  // this fails (including getChatAgent() below).
  getTaskScheduler().pause();
  try {
    const threadStore = getThreadStore();

    const threadMeta = threadStore.getThreadMeta(threadId);
    const effectiveProvider = provider ?? threadMeta?.provider ?? undefined;
    const effectiveModel = model ?? threadMeta?.model ?? undefined;
    if (provider !== undefined || model !== undefined) {
      threadStore.updateThreadModel(threadId, effectiveProvider ?? null, effectiveModel ?? null);
    }

    const { agent, systemPrompt } = await getChatAgent(effectiveProvider, effectiveModel);
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

    const obsConfig = env.observability;
    const store = getObservabilityStore();
    const traceId = store.startTrace({
      threadId,
      provider: effectiveProvider ?? env.defaultProvider,
      model: effectiveModel ?? '',
      source: 'chat',
      systemPrompt,
    });
    const obsHandler = new ObservabilityCallbackHandler(
      traceId,
      store,
      obsConfig.spanOutputPreviewChars,
    );

    const assistantSeq = recordAssistantStart(
      threadStore,
      threadId,
      msgId,
      turnSentAt,
      effectiveProvider,
      effectiveModel,
    );

    setActiveSseWriter(threadId, sink);
    try {
      const eventStream = agent.streamEvents(new Command({ resume: answer }), {
        ...config,
        version: 'v2',
        recursionLimit: env.agent?.recursionLimit ?? 100,
        callbacks: [obsHandler],
        context: {
          provider: effectiveProvider ?? env.defaultProvider,
          // See streamChatToSse's comment — must stay `effectiveModel`, not `effectiveModel ?? ''`.
          model: effectiveModel,
          afterAgentEnabled: afterAgent,
        },
      });

      const {
        content: finalContent,
        thoughtContent,
        finalSegmentId,
      } = await pipeEvents(
        sink,
        msgId,
        eventStream,
        threadStore,
        threadId,
        turnSentAt,
        effectiveProvider,
        effectiveModel,
      );

      store.endTrace(traceId, {
        totalTokens: obsHandler.totalInputTokens + obsHandler.totalOutputTokens,
      });

      await finalizeTurn(
        sink,
        threadStore,
        agent,
        threadId,
        finalSegmentId,
        startedAt,
        finalContent,
        thoughtContent,
        turnSentAt,
        assistantSeq,
        null,
        obsHandler,
        effectiveProvider,
        effectiveModel,
      );
    } catch (err) {
      const {
        segmentId,
        content: partialContent,
        thoughtContent: partialThought,
      } = extractPartialAssistantState(err, msgId);
      if ((err as Error).name === 'GraphRecursionError') {
        const msg =
          'I ran out of steps before finishing. You can reply with instructions to continue, or ask me to summarize what I accomplished so far.';
        finalizeAssistant(threadStore, threadId, segmentId, msg, '', turnSentAt, null);
        writeSseEvent(sink, { type: 'text_delta', messageId: segmentId, delta: msg });
        writeSseEvent(sink, { type: 'stream_done', durationMs: Date.now() - startedAt });
        return;
      }
      failAssistant(threadStore, threadId, segmentId, partialContent, turnSentAt, partialThought);
      throw err;
    } finally {
      clearActiveSseWriter(threadId);
    }
  } finally {
    getTaskScheduler().scheduleResume();
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
): Promise<void> {
  // See streamChatToSse's comment: the whole body runs inside a
  // try/finally from here down so scheduleResume() fires no matter where
  // this fails (including getChatAgent() below).
  getTaskScheduler().pause();
  try {
    const threadStore = getThreadStore();

    const threadMeta = threadStore.getThreadMeta(threadId);
    const effectiveProvider = provider ?? threadMeta?.provider ?? undefined;
    const effectiveModel = model ?? threadMeta?.model ?? undefined;
    if (provider !== undefined || model !== undefined) {
      threadStore.updateThreadModel(threadId, effectiveProvider ?? null, effectiveModel ?? null);
    }

    const { agent, systemPrompt } = await getChatAgent(effectiveProvider, effectiveModel);
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
      effectiveProvider,
      effectiveModel,
    );

    const sink = makeLiveSseWriter(res, threadStore, threadId);
    drainAndRecordWikiUpdates(sink, threadStore, threadId);

    const obsConfig = env.observability;
    const store = getObservabilityStore();
    const traceId = store.startTrace({
      threadId,
      provider: effectiveProvider ?? env.defaultProvider,
      model: effectiveModel ?? '',
      source: 'chat',
      systemPrompt,
    });
    const obsHandler = new ObservabilityCallbackHandler(
      traceId,
      store,
      obsConfig.spanOutputPreviewChars,
    );

    setActiveSseWriter(threadId, sink);
    try {
      const eventStream = agent.streamEvents(null, {
        ...config,
        version: 'v2',
        recursionLimit: env.agent?.recursionLimit ?? 100,
        callbacks: [obsHandler],
        context: {
          provider: effectiveProvider ?? env.defaultProvider,
          // See streamChatToSse's comment — must stay `effectiveModel`, not `effectiveModel ?? ''`.
          model: effectiveModel,
          afterAgentEnabled: afterAgent,
        },
      });

      const {
        content: finalContent,
        thoughtContent,
        finalSegmentId,
      } = await pipeEvents(
        sink,
        msgId,
        eventStream,
        threadStore,
        threadId,
        turnSentAt,
        effectiveProvider,
        effectiveModel,
      );

      store.endTrace(traceId, {
        totalTokens: obsHandler.totalInputTokens + obsHandler.totalOutputTokens,
      });

      await finalizeTurn(
        sink,
        threadStore,
        agent,
        threadId,
        finalSegmentId,
        startedAt,
        finalContent,
        thoughtContent,
        turnSentAt,
        assistantSeq,
        null,
        obsHandler,
        effectiveProvider,
        effectiveModel,
      );
    } catch (err) {
      const {
        segmentId,
        content: partialContent,
        thoughtContent: partialThought,
      } = extractPartialAssistantState(err, msgId);
      if ((err as Error).name === 'GraphRecursionError') {
        const msg =
          'I ran out of steps before finishing. You can reply with instructions to continue, or ask me to summarize what I accomplished so far.';
        finalizeAssistant(threadStore, threadId, segmentId, msg, '', turnSentAt, null);
        writeSseEvent(sink, { type: 'text_delta', messageId: segmentId, delta: msg });
        writeSseEvent(sink, { type: 'stream_done', durationMs: Date.now() - startedAt });
        return;
      }
      failAssistant(threadStore, threadId, segmentId, partialContent, turnSentAt, partialThought);
      throw err;
    } finally {
      clearActiveSseWriter(threadId);
    }
  } finally {
    getTaskScheduler().scheduleResume();
  }
}
