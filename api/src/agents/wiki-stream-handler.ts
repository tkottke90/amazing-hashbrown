import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { Command } from '@langchain/langgraph';
import { getWikiIngestionAgent } from './wiki-ingestion-agent.js';
import { resolveProviderConfig } from '../services/provider-factory.js';
import { setActiveSseWriter, type SseWriter } from './active-sse-writer.js';
import { endThreadTurn } from './pending-thread-turns.js';
import {
  writeSseEvent,
  pipeEvents,
  finalizeTurn,
  extractPartialAssistantState,
  recoverThrownInterrupt,
  ClassifiedTurnError,
} from './stream-handler.js';
import { classifyChatError } from './error-classification.js';
import { env } from '../config/env.js';
import { getThreadStore } from '../services/thread-store.js';
import { resolveTurnModel, startTurnObservability } from './turn-observability.js';
import { getObservabilityStore } from '../services/observability.js';
import { markArtifactReferenced } from '../artifacts/artifact-store.js';
import { resolveAttachmentForTurn, buildAttachmentSpan } from './attachment-resolution.js';
import {
  recordUserMessage,
  recordAssistantStart,
  finalizeAssistant,
  failAssistant,
  resolveHitlPrompt,
  recordRetryAttempt,
} from './thread-message-writer.js';

// Test-only seam — mirrors stream-handler.ts's ChatStreamDeps and
// workspace-chat-stream-handler.ts's WorkspaceChatStreamDeps:
// getWikiIngestionAgent() caches a real agent built against a real
// provider, which a unit test driving a fake aborting event stream cannot
// exercise directly. Defaults to the real implementation everywhere except
// tests.
export interface WikiChatStreamDeps {
  getWikiIngestionAgent?: typeof getWikiIngestionAgent;
}

export async function streamWikiChatToSse(
  res: Response,
  threadId: string,
  content: string,
  startedAt: number,
  provider?: string,
  model?: string,
  attachmentId?: string,
  deps: WikiChatStreamDeps = {},
): Promise<void> {
  const resolveWikiIngestionAgent = deps.getWikiIngestionAgent ?? getWikiIngestionAgent;
  const { agent, systemPrompt } = await resolveWikiIngestionAgent(provider, model);
  const providerConfig = resolveProviderConfig(provider);
  const { provider: resolvedProvider, model: resolvedModel } = resolveTurnModel(provider, model);
  const msgId = randomUUID();
  const threadStore = getThreadStore();
  const turnSentAt = new Date().toISOString();

  threadStore.upsertThreadOnFirstMessage(threadId, content.slice(0, 50), 'wiki');

  const resolution = await resolveAttachmentForTurn(attachmentId, threadId, provider, model);
  const config = {
    configurable: { thread_id: threadId, attachmentInjection: resolution?.injection },
  };

  const userSeq = recordUserMessage(
    threadStore,
    threadId,
    randomUUID(),
    content,
    turnSentAt,
    resolution?.record,
  );
  if (resolution) await markArtifactReferenced(resolution.record.id);

  const turnObs = startTurnObservability({
    threadId,
    provider: resolvedProvider,
    model: resolvedModel,
    source: 'wiki-ingestion',
    systemPrompt,
  });

  if (resolution) {
    getObservabilityStore().saveSpans([
      buildAttachmentSpan(turnObs.traceId, turnSentAt, resolution.record),
    ]);
  }

  const assistantSeq = recordAssistantStart(
    threadStore,
    threadId,
    msgId,
    turnSentAt,
    resolvedProvider,
    resolvedModel,
  );

  const sink: SseWriter = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const controller = new AbortController();
  setActiveSseWriter(threadId, sink, controller);
  let turnError: string | null = null;
  try {
    const eventStream = agent.streamEvents(
      { messages: [{ role: 'human', content }] },
      turnObs.attach({
        ...config,
        version: 'v2',
        context: {
          provider: provider ?? env.defaultProvider,
          model,
        },
        recursionLimit: env.agent?.recursionLimit ?? 100,
        signal: controller.signal,
      }),
    );

    const {
      content: finalContent,
      thoughtContent,
      finalSegmentId,
      hadToolCall,
    } = await pipeEvents(
      sink,
      msgId,
      eventStream,
      threadStore,
      threadId,
      turnSentAt,
      provider,
      model,
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

export async function resumeWikiChatToSse(
  res: Response,
  threadId: string,
  promptId: string,
  answer: string,
  startedAt: number,
  provider?: string,
  model?: string,
  deps: WikiChatStreamDeps = {},
): Promise<void> {
  const resolveWikiIngestionAgent = deps.getWikiIngestionAgent ?? getWikiIngestionAgent;
  const { agent, systemPrompt } = await resolveWikiIngestionAgent(provider, model);
  const providerConfig = resolveProviderConfig(provider);
  const { provider: resolvedProvider, model: resolvedModel } = resolveTurnModel(provider, model);
  const config = { configurable: { thread_id: threadId } };
  const msgId = randomUUID();
  const threadStore = getThreadStore();
  const turnSentAt = new Date().toISOString();

  resolveHitlPrompt(threadStore, threadId, promptId, answer);

  const turnObs = startTurnObservability({
    threadId,
    provider: resolvedProvider,
    model: resolvedModel,
    source: 'wiki-ingestion',
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

  const sink: SseWriter = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const controller = new AbortController();
  setActiveSseWriter(threadId, sink, controller);
  let turnError: string | null = null;
  try {
    const eventStream = agent.streamEvents(
      new Command({ resume: answer }),
      turnObs.attach({
        ...config,
        version: 'v2',
        context: {
          provider: provider ?? env.defaultProvider,
          model,
        },
        recursionLimit: env.agent?.recursionLimit ?? 100,
        signal: controller.signal,
      }),
    );

    const {
      content: finalContent,
      thoughtContent,
      finalSegmentId,
      hadToolCall,
    } = await pipeEvents(
      sink,
      msgId,
      eventStream,
      threadStore,
      threadId,
      turnSentAt,
      provider,
      model,
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

export async function retryWikiChatToSse(
  res: Response,
  threadId: string,
  startedAt: number,
  provider?: string,
  model?: string,
  deps: WikiChatStreamDeps = {},
): Promise<void> {
  const resolveWikiIngestionAgent = deps.getWikiIngestionAgent ?? getWikiIngestionAgent;
  const { agent, systemPrompt } = await resolveWikiIngestionAgent(provider, model);
  const providerConfig = resolveProviderConfig(provider);
  const { provider: resolvedProvider, model: resolvedModel } = resolveTurnModel(provider, model);
  const config = { configurable: { thread_id: threadId } };
  const threadStore = getThreadStore();

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

  const turnObs = startTurnObservability({
    threadId,
    provider: resolvedProvider,
    model: resolvedModel,
    source: 'wiki-ingestion',
    systemPrompt,
  });

  const sink: SseWriter = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const controller = new AbortController();
  setActiveSseWriter(threadId, sink, controller);
  let turnError: string | null = null;
  try {
    const eventStream = agent.streamEvents(
      null,
      turnObs.attach({
        ...config,
        version: 'v2',
        context: {
          provider: provider ?? env.defaultProvider,
          model,
        },
        recursionLimit: env.agent?.recursionLimit ?? 100,
        signal: controller.signal,
      }),
    );

    const {
      content: finalContent,
      thoughtContent,
      finalSegmentId,
      hadToolCall,
    } = await pipeEvents(
      sink,
      msgId,
      eventStream,
      threadStore,
      threadId,
      turnSentAt,
      provider,
      model,
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

export { writeSseEvent, ClassifiedTurnError };
