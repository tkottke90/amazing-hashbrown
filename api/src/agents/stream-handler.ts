import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { Command } from '@langchain/langgraph';
import type { ChatSSEEvent } from '@tkottke90/llm-common-types/chat';
import { getChatAgent } from './chat-agent.js';

// ---- SSE write helper ----

export function writeSseEvent(res: Response, event: ChatSSEEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ---- Thought-block parser ----
// Parses <think>...</think> tokens from a streaming LLM response.
// Maintains buffer state across chunk boundaries so split tags are handled correctly.

interface ParseState {
  inThought: boolean;
  buf: string;
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
          writeSseEvent(res, { type: 'thought_delta', messageId: msgId, delta: state.buf.slice(0, closeIdx) });
        }
        state.buf = state.buf.slice(closeIdx + CLOSE_TAG.length);
        state.inThought = false;
      } else {
        const safe = state.buf.length > SAFE_MARGIN ? state.buf.slice(0, -SAFE_MARGIN) : '';
        if (safe) {
          writeSseEvent(res, { type: 'thought_delta', messageId: msgId, delta: safe });
          state.buf = state.buf.slice(safe.length);
        }
        break;
      }
    } else {
      const openIdx = state.buf.indexOf(OPEN_TAG);
      if (openIdx >= 0) {
        if (openIdx > 0) {
          writeSseEvent(res, { type: 'text_delta', messageId: msgId, delta: state.buf.slice(0, openIdx) });
        }
        state.buf = state.buf.slice(openIdx + OPEN_TAG.length);
        state.inThought = true;
      } else {
        const safe = state.buf.length > SAFE_MARGIN ? state.buf.slice(0, -SAFE_MARGIN) : '';
        if (safe) {
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
    writeSseEvent(res, {
      type: state.inThought ? 'thought_delta' : 'text_delta',
      messageId: msgId,
      delta: state.buf,
    });
    state.buf = '';
  }
}

// ---- LangGraph event → SSE ----

async function pipeEvents(
  res: Response,
  msgId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eventStream: AsyncIterable<any>,
): Promise<void> {
  const parse: ParseState = { inThought: false, buf: '' };

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
          writeSseEvent(res, {
            type: 'tool_call_start',
            messageId: randomUUID(),
            toolCallId: evt.run_id as string,
            toolName: evt.name as string,
            inputs: (evt.data?.input ?? {}) as Record<string, unknown>,
          });
        }
        break;
      }

      case 'on_tool_end': {
        if (evt.name !== 'ask_user') {
          writeSseEvent(res, {
            type: 'tool_call_end',
            toolCallId: evt.run_id as string,
            outputs: evt.data?.output,
          });
        }
        break;
      }
    }
  }

  drainBuffer(res, msgId, parse);
}

// ---- Check for a pending interrupt and emit hitl_prompt if found ----

async function emitHitlOrDone(
  res: Response,
  msgId: string,
  threadId: string,
  startedAt: number,
): Promise<void> {
  const agent = getChatAgent();
  const config = { configurable: { thread_id: threadId } };
  const state = await agent.getState(config);
  const interrupt = state.tasks?.[0]?.interrupts?.[0];

  if (interrupt) {
    const { question, kind, choices } = interrupt.value as {
      question: string;
      kind: 'yes_no' | 'multiple_choice' | 'free_text';
      choices?: string[];
    };
    writeSseEvent(res, {
      type: 'hitl_prompt',
      messageId: msgId,
      promptId: randomUUID(),
      question,
      kind,
      choices,
    });
  } else {
    writeSseEvent(res, { type: 'stream_done', durationMs: Date.now() - startedAt });
  }
}

// ---- Public handlers ----

export async function streamChatToSse(
  res: Response,
  threadId: string,
  content: string,
  startedAt: number,
): Promise<void> {
  const agent = getChatAgent();
  const config = { configurable: { thread_id: threadId } };
  const msgId = randomUUID();

  const eventStream = agent.streamEvents(
    { messages: [{ role: 'human', content }] },
    { ...config, version: 'v2' },
  );

  await pipeEvents(res, msgId, eventStream);
  await emitHitlOrDone(res, msgId, threadId, startedAt);
}

export async function resumeChatToSse(
  res: Response,
  threadId: string,
  answer: string,
  startedAt: number,
): Promise<void> {
  const agent = getChatAgent();
  const config = { configurable: { thread_id: threadId } };
  const msgId = randomUUID();

  const eventStream = agent.streamEvents(
    new Command({ resume: answer }),
    { ...config, version: 'v2' },
  );

  await pipeEvents(res, msgId, eventStream);
  await emitHitlOrDone(res, msgId, threadId, startedAt);
}
