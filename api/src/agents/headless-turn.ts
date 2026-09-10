import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { logger, serializeError } from '../config/logger.js';
import type { ThreadStore } from '../services/thread-store.js';
import { getProviderQueue } from '../services/provider-queue.js';
import {
  getActiveSseWriter,
  setActiveSseWriter,
  clearActiveSseWriter,
  type SseWriter,
} from './active-sse-writer.js';
import { pipeEvents, finalizeTurn } from './stream-handler.js';
import { recordAssistantStart } from './thread-message-writer.js';
import { drainPendingTurns } from './pending-thread-turns.js';

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
  recursionLimit?: number;
  workspaceId?: string;
  // Set only when this notification is itself about a task-originated
  // thread — threaded into finalizeTurn's hitl_prompt payload the same way
  // task-execution.ts's own run does, so a /hitl resume on THIS turn (if it
  // asks the user something) re-enqueues correctly rather than resuming an
  // interactive turn. Omitted for chat/workspace-chat parent threads.
  taskId?: string;
}

// Runs one system-generated turn against an existing thread with no live
// SSE connection watching it — the same headless shape task-execution.ts
// uses for an automated task run (agent already built by the caller,
// stream, pipe, finalize), reused here for a spawn_sub_agent completion
// notification (see sub-agent-notification.ts). Claims/releases the
// per-thread mutex (active-sse-writer.ts) itself and drains the next queued
// pending turn on release — see pending-thread-turns.ts. Never throws: a
// failure here must not crash the sub-agent completion path that invoked
// it, only fail to deliver this one notification.
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
  setActiveSseWriter(threadId, sink);

  try {
    const msgId = randomUUID();
    const turnSentAt = new Date().toISOString();
    const startedAt = Date.now();
    const assistantSeq = recordAssistantStart(threadStore, threadId, msgId, turnSentAt);

    const config = {
      configurable: {
        thread_id: threadId,
        ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      },
    };

    const { content, thoughtContent, finalSegmentId, hadToolCall } =
      await getProviderQueue().withSlot(provider, 'sync', async () => {
        const rawStream = agent.streamEvents(
          { messages: [{ role: 'human', content: message }] },
          {
            ...config,
            version: 'v2',
            recursionLimit,
            context: { provider, model: undefined, afterAgentEnabled: undefined },
          },
        );
        return pipeEvents(sink, msgId, rawStream, threadStore, threadId, turnSentAt);
      });

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
      undefined,
      provider,
      undefined,
      taskId,
    );
  } catch (err) {
    logger.error('headless-turn: notification turn failed', {
      threadId,
      err: serializeError(err),
    });
  } finally {
    clearActiveSseWriter(threadId);
    drainPendingTurns(threadId);
  }
}
