import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Response } from 'express';
import { Command } from '@langchain/langgraph';
import { logger, serializeError } from '../config/logger.js';
import { getWorkspaceChatAgent, type WorkspaceChatContext } from './chat-agent.js';
import { setActiveSseWriter, getActiveSseWriter, type SseWriter } from './active-sse-writer.js';
import { endThreadTurn } from './pending-thread-turns.js';
import {
  writeSseEvent,
  pipeEvents,
  finalizeTurn,
  drainAndRecordWikiUpdates,
  extractPartialAssistantState,
  recoverThrownInterrupt,
  ClassifiedTurnError,
} from './stream-handler.js';
import { classifyChatError } from './error-classification.js';
import { env } from '../config/env.js';
import { getThreadStore } from '../services/thread-store.js';
import { getWikiRegistry } from '../services/wiki.js';
import { createProvider, resolveProviderConfig } from '../services/provider-factory.js';
import { getProviderQueue } from '../services/provider-queue.js';
import { getWorkspaceStore, type Workspace } from '../services/workspace-store.js';
import { resolveTurnModel, startTurnObservability } from './turn-observability.js';
import { maybeSummarizeWorkspace } from './workspace-summarizer.js';
import {
  recordUserMessage,
  recordAssistantStart,
  finalizeAssistant,
  failAssistant,
  resolveHitlPrompt,
  recordRetryAttempt,
} from './thread-message-writer.js';

// Reads .hashbrown/summaries/ under the workspace's location: the most
// recent file's full content, plus older files reduced to a manifest
// (path + filename-derived timestamp) so steady-state cost doesn't grow
// with how many summaries a long-running workspace accumulates. Never
// throws — a missing directory (the common case: never summarized) or an
// unreadable file just means no summary context for this turn.
async function loadWorkspaceSummaries(
  workspace: Workspace,
): Promise<Pick<WorkspaceChatContext, 'latestSummary' | 'olderSummaries'>> {
  const dir = path.join(workspace.location, '.hashbrown', 'summaries');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('workspace-chat: failed to list summaries directory', {
        workspaceId: workspace.id,
        err: serializeError(err),
      });
    }
    return { latestSummary: null, olderSummaries: [] };
  }
  if (files.length === 0) return { latestSummary: null, olderSummaries: [] };

  const latestFile = files[files.length - 1];
  if (!latestFile) return { latestSummary: null, olderSummaries: [] }; // unreachable, satisfies TS
  let latestSummary: string | null = null;
  try {
    latestSummary = await readFile(path.join(dir, latestFile), 'utf8');
  } catch (err) {
    logger.warn('workspace-chat: failed to read latest summary file', {
      workspaceId: workspace.id,
      err: serializeError(err),
    });
  }

  const olderSummaries = files.slice(0, -1).map((f) => ({
    path: path.join('.hashbrown', 'summaries', f),
    timestamp: f.replace(/\.md$/, ''), // filename is already a sortable, readable timestamp
  }));

  return { latestSummary, olderSummaries };
}

// Exported so task-execution.ts (automated task runs) can build the same
// workspace-context block a workspace-chat turn uses, without duplicating
// the wiki-domain lookup logic.
export async function buildWorkspaceContext(workspace: Workspace): Promise<WorkspaceChatContext> {
  let wikiDomain: string | null = null;
  if (workspace.wikiId) {
    try {
      const registry = await getWikiRegistry();
      wikiDomain = registry.list().find((w) => w.id === workspace.wikiId)?.domain ?? null;
    } catch (err) {
      logger.warn('workspace-chat: failed to resolve wiki domain for orientation', {
        workspaceId: workspace.id,
        wikiId: workspace.wikiId,
        err: serializeError(err),
      });
    }
  }
  const { latestSummary, olderSummaries } = await loadWorkspaceSummaries(workspace);
  return {
    name: workspace.name,
    goal: workspace.goal,
    location: workspace.location,
    systemPrompt: workspace.systemPrompt,
    wikiDomain,
    latestSummary,
    olderSummaries,
  };
}

// Test-only seam — mirrors stream-handler.ts's ChatStreamDeps and
// task-execution.ts's ExecuteTaskDeps: getWorkspaceChatAgent() caches a real
// agent built against a real provider, which a unit test driving a fake
// aborting event stream cannot exercise directly. Defaults to the real
// implementation everywhere except tests.
export interface WorkspaceChatStreamDeps {
  getWorkspaceChatAgent?: typeof getWorkspaceChatAgent;
}

export async function streamWorkspaceChatToSse(
  res: Response,
  workspace: Workspace,
  threadId: string,
  content: string,
  startedAt: number,
  provider?: string,
  model?: string,
  afterAgent?: boolean,
  deps: WorkspaceChatStreamDeps = {},
): Promise<void> {
  const resolveWorkspaceChatAgent = deps.getWorkspaceChatAgent ?? getWorkspaceChatAgent;
  const workspaceStore = getWorkspaceStore();
  const threadStore = getThreadStore();
  const sink: SseWriter = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Another turn currently owns this exact thread (a chat turn still
  // streaming, or a headless sub-agent notification) — reject rather than
  // race a second agent.streamEvents() invocation against the same
  // LangGraph checkpoint. Automated task runs no longer land here: each run
  // executes in its own thread (see task-execution.ts).
  if (getActiveSseWriter(threadId)) {
    writeSseEvent(sink, {
      type: 'stream_error',
      error: 'This workspace chat is busy with another turn — try again in a moment.',
    });
    return;
  }

  threadStore.upsertThreadOnFirstMessage(threadId, content.slice(0, 50), 'workspace-chat');

  const threadMeta = threadStore.getThreadMeta(threadId);
  const effectiveProvider = provider ?? threadMeta?.provider ?? undefined;
  const effectiveModel = model ?? threadMeta?.model ?? undefined;
  if (provider !== undefined || model !== undefined) {
    threadStore.updateThreadModel(threadId, effectiveProvider ?? null, effectiveModel ?? null);
  }

  const workspaceContext = await buildWorkspaceContext(workspace);
  const { agent, systemPrompt } = await resolveWorkspaceChatAgent(
    workspace.id,
    workspaceContext,
    effectiveProvider,
    effectiveModel,
  );
  const providerConfig = resolveProviderConfig(effectiveProvider);
  const { provider: resolvedProvider, model: resolvedModel } = resolveTurnModel(
    effectiveProvider,
    effectiveModel,
  );
  const config = {
    configurable: {
      thread_id: threadId,
      workspaceId: workspace.id,
    },
  };
  const msgId = randomUUID();
  const turnSentAt = new Date().toISOString();

  const userSeq = recordUserMessage(threadStore, threadId, randomUUID(), content, turnSentAt);

  drainAndRecordWikiUpdates(sink, threadStore, threadId);

  const turnObs = startTurnObservability({
    threadId,
    provider: resolvedProvider,
    model: resolvedModel,
    source: 'workspace-chat',
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
          { messages: [{ role: 'human', content }] },
          turnObs.attach({
            ...config,
            version: 'v2',
            context: {
              provider: effectiveProvider ?? env.defaultProvider,
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
    );

    await maybeSummarizeWorkspace(
      sink,
      workspaceStore,
      threadStore,
      workspace,
      agent,
      createProvider(resolvedProvider, resolvedModel),
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

export async function resumeWorkspaceChatToSse(
  res: Response,
  workspace: Workspace,
  threadId: string,
  promptId: string,
  answer: string,
  startedAt: number,
  provider?: string,
  model?: string,
  afterAgent?: boolean,
  deps: WorkspaceChatStreamDeps = {},
): Promise<void> {
  const resolveWorkspaceChatAgent = deps.getWorkspaceChatAgent ?? getWorkspaceChatAgent;
  const workspaceStore = getWorkspaceStore();
  const threadStore = getThreadStore();
  const sink: SseWriter = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  if (getActiveSseWriter(threadId)) {
    writeSseEvent(sink, {
      type: 'stream_error',
      error: 'This workspace chat is busy with another turn — try again in a moment.',
    });
    return;
  }

  const threadMeta = threadStore.getThreadMeta(threadId);
  const effectiveProvider = provider ?? threadMeta?.provider ?? undefined;
  const effectiveModel = model ?? threadMeta?.model ?? undefined;
  if (provider !== undefined || model !== undefined) {
    threadStore.updateThreadModel(threadId, effectiveProvider ?? null, effectiveModel ?? null);
  }

  const workspaceContext = await buildWorkspaceContext(workspace);
  const { agent, systemPrompt } = await resolveWorkspaceChatAgent(
    workspace.id,
    workspaceContext,
    effectiveProvider,
    effectiveModel,
  );
  const providerConfig = resolveProviderConfig(effectiveProvider);
  const { provider: resolvedProvider, model: resolvedModel } = resolveTurnModel(
    effectiveProvider,
    effectiveModel,
  );
  const config = {
    configurable: {
      thread_id: threadId,
      workspaceId: workspace.id,
    },
  };
  const msgId = randomUUID();
  const turnSentAt = new Date().toISOString();

  try {
    resolveHitlPrompt(threadStore, threadId, promptId, answer);
  } catch (err) {
    logger.error('resumeWorkspaceChatToSse: failed to resolve HITL prompt', {
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
    source: 'workspace-chat',
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

    await maybeSummarizeWorkspace(
      sink,
      workspaceStore,
      threadStore,
      workspace,
      agent,
      createProvider(resolvedProvider, resolvedModel),
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

export async function retryWorkspaceChatToSse(
  res: Response,
  workspace: Workspace,
  threadId: string,
  startedAt: number,
  provider?: string,
  model?: string,
  afterAgent?: boolean,
  deps: WorkspaceChatStreamDeps = {},
): Promise<void> {
  const resolveWorkspaceChatAgent = deps.getWorkspaceChatAgent ?? getWorkspaceChatAgent;
  const workspaceStore = getWorkspaceStore();
  const threadStore = getThreadStore();
  const sink: SseWriter = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  if (getActiveSseWriter(threadId)) {
    writeSseEvent(sink, {
      type: 'stream_error',
      error: 'This workspace chat is busy with another turn — try again in a moment.',
    });
    return;
  }

  const threadMeta = threadStore.getThreadMeta(threadId);
  const effectiveProvider = provider ?? threadMeta?.provider ?? undefined;
  const effectiveModel = model ?? threadMeta?.model ?? undefined;
  if (provider !== undefined || model !== undefined) {
    threadStore.updateThreadModel(threadId, effectiveProvider ?? null, effectiveModel ?? null);
  }

  const workspaceContext = await buildWorkspaceContext(workspace);
  const { agent, systemPrompt } = await resolveWorkspaceChatAgent(
    workspace.id,
    workspaceContext,
    effectiveProvider,
    effectiveModel,
  );
  const providerConfig = resolveProviderConfig(effectiveProvider);
  const { provider: resolvedProvider, model: resolvedModel } = resolveTurnModel(
    effectiveProvider,
    effectiveModel,
  );
  const config = {
    configurable: {
      thread_id: threadId,
      workspaceId: workspace.id,
    },
  };

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

  drainAndRecordWikiUpdates(sink, threadStore, threadId);

  const turnObs = startTurnObservability({
    threadId,
    provider: resolvedProvider,
    model: resolvedModel,
    source: 'workspace-chat',
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

    await maybeSummarizeWorkspace(
      sink,
      workspaceStore,
      threadStore,
      workspace,
      agent,
      createProvider(resolvedProvider, resolvedModel),
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
