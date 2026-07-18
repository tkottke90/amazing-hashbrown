import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { Command } from '@langchain/langgraph';
import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';
import { getChatAgent, type ChatAgent } from './chat-agent.js';
import { env } from '../config/env.js';
import { getObservabilityStore } from '../services/observability.js';
import { getThreadStore, type ThreadStore } from '../services/thread-store.js';
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
} from './thread-message-writer.js';

// ---- SSE write helper ----

export function writeSseEvent(res: Response, event: ChatSSEEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
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

function flushDelta(res: Response, msgId: string, state: ParseState, chunk: string): void {
  state.buf += chunk;

  while (state.buf.length > 0) {
    if (state.inThought) {
      const closeIdx = state.buf.indexOf(CLOSE_TAG);
      if (closeIdx >= 0) {
        if (closeIdx > 0) {
          const delta = state.buf.slice(0, closeIdx);
          state.thought += delta;
          writeSseEvent(res, { type: 'thought_delta', messageId: msgId, delta });
        }
        state.buf = state.buf.slice(closeIdx + CLOSE_TAG.length);
        state.inThought = false;
      } else {
        const safe = state.buf.length > SAFE_MARGIN ? state.buf.slice(0, -SAFE_MARGIN) : '';
        if (safe) {
          state.thought += safe;
          writeSseEvent(res, { type: 'thought_delta', messageId: msgId, delta: safe });
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
          writeSseEvent(res, { type: 'text_delta', messageId: msgId, delta });
        }
        state.buf = state.buf.slice(openIdx + OPEN_TAG.length);
        state.inThought = true;
      } else {
        const safe = state.buf.length > SAFE_MARGIN ? state.buf.slice(0, -SAFE_MARGIN) : '';
        if (safe) {
          state.content += safe;
          writeSseEvent(res, { type: 'text_delta', messageId: msgId, delta: safe });
          state.buf = state.buf.slice(safe.length);
        }
        break;
      }
    }
  }
}

function drainBuffer(res: Response, msgId: string, state: ParseState): void {
  if (state.buf) {
    if (state.inThought) state.thought += state.buf;
    else state.content += state.buf;
    writeSseEvent(res, {
      type: state.inThought ? 'thought_delta' : 'text_delta',
      messageId: msgId,
      delta: state.buf,
    });
    state.buf = '';
  }
}

// ---- LangGraph event → SSE (+ thread_messages persistence) ----

// Exported for direct testing — the highest-risk piece of this module (does
// accumulation + tool-call bookkeeping wire correctly to the persistence
// layer) without needing a live LLM through the full getChatAgent() chain.
export async function pipeEvents(
  res: Response,
  msgId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eventStream: AsyncIterable<any>,
  threadStore: ThreadStore,
  threadId: string,
): Promise<{ content: string; thoughtContent: string }> {
  const parse: ParseState = { inThought: false, buf: '', content: '', thought: '' };
  // updateMessage() replaces payload wholesale rather than merging, so
  // finalizeToolCall needs the original toolName/inputs back — tracked here
  // for the lifetime of this one turn.
  const toolCallsInFlight = new Map<
    string,
    { toolName: string; inputs: Record<string, unknown> }
  >();

  for await (const evt of eventStream) {
    switch (evt.event) {
      case 'on_chat_model_stream': {
        const content = evt.data?.chunk?.content;
        if (typeof content === 'string' && content.length > 0) {
          flushDelta(res, msgId, parse, content);
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
          writeSseEvent(res, {
            type: 'tool_call_start',
            messageId: randomUUID(),
            toolCallId,
            toolName,
            inputs,
            ...(seq !== null ? { seq } : {}),
          });
        }
        break;
      }

      case 'on_tool_end': {
        if (evt.name !== 'ask_user') {
          const toolCallId = evt.run_id as string;
          const outputs = evt.data?.output;
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
          writeSseEvent(res, {
            type: 'tool_call_end',
            toolCallId,
            outputs,
          });
        }
        break;
      }
    }
  }

  drainBuffer(res, msgId, parse);
  return { content: parse.content, thoughtContent: parse.thought };
}

// ---- Finalize the assistant row, then emit either a HITL prompt or done ----

async function finalizeTurn(
  res: Response,
  threadStore: ThreadStore,
  agent: ChatAgent,
  threadId: string,
  msgId: string,
  startedAt: number,
  content: string,
  thoughtContent: string,
  turnSentAt: string,
  assistantSeq: number | null,
  userSeq: number | null,
): Promise<void> {
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

  const interrupt = state.tasks?.[0]?.interrupts?.[0];

  if (interrupt) {
    const { question, kind, choices, allowFreeText, approveLabel, approveType, rejectLabel } =
      interrupt.value as {
        question: string;
        kind: 'yes_no' | 'multiple_choice' | 'free_text';
        choices?: string[];
        allowFreeText?: boolean;
        approveLabel?: string;
        approveType?: 'primary' | 'secondary' | 'destructive';
        rejectLabel?: string;
      };
    const promptId = randomUUID();
    const promptSeq = recordHitlPrompt(threadStore, threadId, promptId, {
      question,
      promptKind: kind,
      choices,
      allowFreeText,
      approveLabel,
      approveType,
      rejectLabel,
    });
    writeSseEvent(res, {
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
      ...(promptSeq !== null ? { seq: promptSeq } : {}),
      ...(assistantSeq !== null ? { assistantSeq } : {}),
      ...(userSeq !== null ? { userSeq } : {}),
    });
  } else {
    writeSseEvent(res, {
      type: 'stream_done',
      durationMs: Date.now() - startedAt,
      ...(assistantSeq !== null ? { assistantSeq } : {}),
      ...(userSeq !== null ? { userSeq } : {}),
    });
  }
}

function drainAndRecordWikiUpdates(
  res: Response,
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
      writeSseEvent(res, seq !== null ? { ...event, seq } : event);
    } else {
      writeSseEvent(res, event);
    }
  }
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
  const agent = await getChatAgent(provider, model);
  const config = { configurable: { thread_id: threadId } };
  const msgId = randomUUID();
  const threadStore = getThreadStore();
  const turnSentAt = new Date().toISOString();

  threadStore.upsertThreadOnFirstMessage(threadId, content.slice(0, 50));
  const userSeq = recordUserMessage(threadStore, threadId, randomUUID(), content, turnSentAt);

  drainAndRecordWikiUpdates(res, threadStore, threadId);

  const obsConfig = env.observability;
  const store = getObservabilityStore();
  const traceId = store.startTrace({
    threadId,
    provider: provider ?? env.defaultProvider,
    model: model ?? '',
  });
  const obsHandler = new ObservabilityCallbackHandler(
    traceId,
    store,
    obsConfig.spanOutputPreviewChars,
  );

  const assistantSeq = recordAssistantStart(threadStore, threadId, msgId, turnSentAt);

  try {
    const eventStream = agent.streamEvents(
      { messages: [{ role: 'human', content }] },
      {
        ...config,
        version: 'v2',
        callbacks: [obsHandler],
        context: {
          provider: provider ?? env.defaultProvider,
          // Left as `model` (not `model ?? ''`) so an unset request model stays
          // undefined here — AfterAgent reads this straight into
          // createProvider(provider, model), where `'' ?? config.defaultModel`
          // would resolve to '' (an empty string isn't nullish) instead of
          // falling through to the provider's configured defaultModel.
          model,
          afterAgentEnabled: afterAgent,
        },
      },
    );

    const { content: finalContent, thoughtContent } = await pipeEvents(
      res,
      msgId,
      eventStream,
      threadStore,
      threadId,
    );

    store.endTrace(traceId, {
      totalTokens: obsHandler.totalInputTokens + obsHandler.totalOutputTokens,
    });

    await finalizeTurn(
      res,
      threadStore,
      agent,
      threadId,
      msgId,
      startedAt,
      finalContent,
      thoughtContent,
      turnSentAt,
      assistantSeq,
      userSeq,
    );
  } catch (err) {
    failAssistant(threadStore, threadId, msgId, '', turnSentAt);
    throw err;
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
  const agent = await getChatAgent(provider, model);
  const config = { configurable: { thread_id: threadId } };
  const msgId = randomUUID();
  const threadStore = getThreadStore();
  const turnSentAt = new Date().toISOString();

  resolveHitlPrompt(threadStore, threadId, promptId, answer);

  drainAndRecordWikiUpdates(res, threadStore, threadId);

  const obsConfig = env.observability;
  const store = getObservabilityStore();
  const traceId = store.startTrace({
    threadId,
    provider: provider ?? env.defaultProvider,
    model: model ?? '',
  });
  const obsHandler = new ObservabilityCallbackHandler(
    traceId,
    store,
    obsConfig.spanOutputPreviewChars,
  );

  const assistantSeq = recordAssistantStart(threadStore, threadId, msgId, turnSentAt);

  try {
    const eventStream = agent.streamEvents(new Command({ resume: answer }), {
      ...config,
      version: 'v2',
      callbacks: [obsHandler],
      context: {
        provider: provider ?? env.defaultProvider,
        // See streamChatToSse's comment — must stay `model`, not `model ?? ''`.
        model,
        afterAgentEnabled: afterAgent,
      },
    });

    const { content: finalContent, thoughtContent } = await pipeEvents(
      res,
      msgId,
      eventStream,
      threadStore,
      threadId,
    );

    store.endTrace(traceId, {
      totalTokens: obsHandler.totalInputTokens + obsHandler.totalOutputTokens,
    });

    await finalizeTurn(
      res,
      threadStore,
      agent,
      threadId,
      msgId,
      startedAt,
      finalContent,
      thoughtContent,
      turnSentAt,
      assistantSeq,
      null,
    );
  } catch (err) {
    failAssistant(threadStore, threadId, msgId, '', turnSentAt);
    throw err;
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
  const agent = await getChatAgent(provider, model);
  const config = { configurable: { thread_id: threadId } };
  const threadStore = getThreadStore();

  const failedId = threadStore.resolveRetryTarget(threadId);
  if (!failedId) {
    throw new Error(`Thread "${threadId}" has no retryable (failed) turn`);
  }

  const msgId = randomUUID();
  const turnSentAt = new Date().toISOString();
  const assistantSeq = recordRetryAttempt(threadStore, threadId, msgId, failedId, turnSentAt);

  drainAndRecordWikiUpdates(res, threadStore, threadId);

  const obsConfig = env.observability;
  const store = getObservabilityStore();
  const traceId = store.startTrace({
    threadId,
    provider: provider ?? env.defaultProvider,
    model: model ?? '',
  });
  const obsHandler = new ObservabilityCallbackHandler(
    traceId,
    store,
    obsConfig.spanOutputPreviewChars,
  );

  try {
    const eventStream = agent.streamEvents(null, {
      ...config,
      version: 'v2',
      callbacks: [obsHandler],
      context: {
        provider: provider ?? env.defaultProvider,
        // See streamChatToSse's comment — must stay `model`, not `model ?? ''`.
        model,
        afterAgentEnabled: afterAgent,
      },
    });

    const { content: finalContent, thoughtContent } = await pipeEvents(
      res,
      msgId,
      eventStream,
      threadStore,
      threadId,
    );

    store.endTrace(traceId, {
      totalTokens: obsHandler.totalInputTokens + obsHandler.totalOutputTokens,
    });

    await finalizeTurn(
      res,
      threadStore,
      agent,
      threadId,
      msgId,
      startedAt,
      finalContent,
      thoughtContent,
      turnSentAt,
      assistantSeq,
      null,
    );
  } catch (err) {
    failAssistant(threadStore, threadId, msgId, '', turnSentAt);
    throw err;
  }
}
