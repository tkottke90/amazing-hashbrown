import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { Command } from '@langchain/langgraph';
import { getWikiIngestionAgent } from './wiki-ingestion-agent.js';
import { resolveProviderConfig } from '../services/provider-factory.js';
import { setActiveSseWriter, clearActiveSseWriter, type SseWriter } from './active-sse-writer.js';
import {
  writeSseEvent,
  pipeEvents,
  finalizeTurn,
  extractPartialAssistantState,
} from './stream-handler.js';
import { env } from '../config/env.js';
import { getObservabilityStore } from '../services/observability.js';
import { getThreadStore } from '../services/thread-store.js';
import { ObservabilityCallbackHandler } from './observability-handler.js';
import {
  recordUserMessage,
  recordAssistantStart,
  finalizeAssistant,
  failAssistant,
  resolveHitlPrompt,
  recordRetryAttempt,
} from './thread-message-writer.js';

export async function streamWikiChatToSse(
  res: Response,
  threadId: string,
  content: string,
  startedAt: number,
  provider?: string,
  model?: string,
): Promise<void> {
  const { agent, systemPrompt } = await getWikiIngestionAgent(provider, model);
  const providerConfig = resolveProviderConfig(provider);
  const resolvedProvider = providerConfig.name;
  const resolvedModel = model ?? providerConfig.defaultModel!;
  const config = { configurable: { thread_id: threadId } };
  const msgId = randomUUID();
  const threadStore = getThreadStore();
  const turnSentAt = new Date().toISOString();

  threadStore.upsertThreadOnFirstMessage(threadId, content.slice(0, 50), 'wiki');
  const userSeq = recordUserMessage(threadStore, threadId, randomUUID(), content, turnSentAt);

  const obsConfig = env.observability;
  const store = getObservabilityStore();
  const traceId = store.startTrace({
    threadId,
    provider: resolvedProvider,
    model: resolvedModel,
    source: 'wiki-ingestion',
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
    resolvedProvider,
    resolvedModel,
  );

  const sink: SseWriter = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  setActiveSseWriter(threadId, sink);
  try {
    const eventStream = agent.streamEvents(
      { messages: [{ role: 'human', content }] },
      {
        ...config,
        version: 'v2',
        callbacks: [obsHandler],
        context: {
          provider: provider ?? env.defaultProvider,
          model,
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
      provider,
      model,
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
      resolvedProvider,
      resolvedModel,
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
}

export async function resumeWikiChatToSse(
  res: Response,
  threadId: string,
  promptId: string,
  answer: string,
  startedAt: number,
  provider?: string,
  model?: string,
): Promise<void> {
  const { agent, systemPrompt } = await getWikiIngestionAgent(provider, model);
  const providerConfig = resolveProviderConfig(provider);
  const resolvedProvider = providerConfig.name;
  const resolvedModel = model ?? providerConfig.defaultModel!;
  const config = { configurable: { thread_id: threadId } };
  const msgId = randomUUID();
  const threadStore = getThreadStore();
  const turnSentAt = new Date().toISOString();

  resolveHitlPrompt(threadStore, threadId, promptId, answer);

  const obsConfig = env.observability;
  const store = getObservabilityStore();
  const traceId = store.startTrace({
    threadId,
    provider: resolvedProvider,
    model: resolvedModel,
    source: 'wiki-ingestion',
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
    resolvedProvider,
    resolvedModel,
  );

  const sink: SseWriter = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  setActiveSseWriter(threadId, sink);
  try {
    const eventStream = agent.streamEvents(new Command({ resume: answer }), {
      ...config,
      version: 'v2',
      callbacks: [obsHandler],
      context: {
        provider: provider ?? env.defaultProvider,
        model,
      },
      recursionLimit: env.agent?.recursionLimit ?? 100,
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
      provider,
      model,
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
      resolvedProvider,
      resolvedModel,
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
}

export async function retryWikiChatToSse(
  res: Response,
  threadId: string,
  startedAt: number,
  provider?: string,
  model?: string,
): Promise<void> {
  const { agent, systemPrompt } = await getWikiIngestionAgent(provider, model);
  const providerConfig = resolveProviderConfig(provider);
  const resolvedProvider = providerConfig.name;
  const resolvedModel = model ?? providerConfig.defaultModel!;
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

  const obsConfig = env.observability;
  const store = getObservabilityStore();
  const traceId = store.startTrace({
    threadId,
    provider: resolvedProvider,
    model: resolvedModel,
    source: 'wiki-ingestion',
    systemPrompt,
  });
  const obsHandler = new ObservabilityCallbackHandler(
    traceId,
    store,
    obsConfig.spanOutputPreviewChars,
  );

  const sink: SseWriter = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  setActiveSseWriter(threadId, sink);
  try {
    const eventStream = agent.streamEvents(null, {
      ...config,
      version: 'v2',
      callbacks: [obsHandler],
      context: {
        provider: provider ?? env.defaultProvider,
        model,
      },
      recursionLimit: env.agent?.recursionLimit ?? 100,
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
      provider,
      model,
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
      resolvedProvider,
      resolvedModel,
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
}

export { writeSseEvent };
