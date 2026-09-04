import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { Command } from '@langchain/langgraph';
import { logger, serializeError } from '../config/logger.js';
import { getWorkspaceChatAgent, type WorkspaceChatContext } from './chat-agent.js';
import {
  setActiveSseWriter,
  clearActiveSseWriter,
  getActiveSseWriter,
  type SseWriter,
} from './active-sse-writer.js';
import {
  writeSseEvent,
  pipeEvents,
  finalizeTurn,
  drainAndRecordWikiUpdates,
  extractPartialAssistantState,
} from './stream-handler.js';
import { env } from '../config/env.js';
import { getObservabilityStore } from '../services/observability.js';
import { getThreadStore } from '../services/thread-store.js';
import { getTaskScheduler } from '../services/task-scheduler.js';
import { getWikiRegistry } from '../services/wiki.js';
import { createProvider, resolveProviderConfig } from '../services/provider-factory.js';
import {
  getWorkspaceStore,
  type Workspace,
  type WorkspaceStore,
} from '../services/workspace-store.js';
import { ObservabilityCallbackHandler } from './observability-handler.js';
import { maybeSummarizeWorkspace } from './workspace-summarizer.js';
import {
  recordUserMessage,
  recordAssistantStart,
  finalizeAssistant,
  failAssistant,
  resolveHitlPrompt,
  recordRetryAttempt,
} from './thread-message-writer.js';

// A project workspace may only write to its own configured wiki — resolved
// once per turn and passed to getWorkspaceChatAgent(), which builds the
// agent's wiki write tools with this value closed over (see
// buildWikiWriteTools() in chat-agent.ts). undefined for a non-project
// workspace, meaning unrestricted, matching today's global-chat behavior.
export function resolveAllowedWikiId(
  store: WorkspaceStore,
  workspaceId: string,
): string | undefined {
  const project = store.getProject(workspaceId);
  if (!project) return undefined;
  return store.getWorkspace(workspaceId)?.wikiId ?? undefined;
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
  return {
    name: workspace.name,
    goal: workspace.goal,
    location: workspace.location,
    systemPrompt: workspace.systemPrompt,
    wikiDomain,
  };
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
): Promise<void> {
  // Same pause/resume discipline as streamChatToSse (issue #68) — a
  // workspace-chat turn pauses the background task queue exactly like a
  // global-chat turn does. wiki-stream-handler.ts does NOT do this; this
  // must be copied from stream-handler.ts directly.
  getTaskScheduler().pause();
  try {
    const workspaceStore = getWorkspaceStore();
    const threadStore = getThreadStore();
    const sink: SseWriter = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // An automated task run currently owns this exact thread (task-execution.ts
    // registers itself the same way a chat turn does) — reject rather than
    // race a second agent.streamEvents() invocation against the same
    // LangGraph checkpoint. Interrupting the task run itself is #86's job.
    if (getActiveSseWriter(threadId)) {
      writeSseEvent(sink, {
        type: 'stream_error',
        error: 'This workspace has a task running — try again in a moment.',
      });
      return;
    }

    threadStore.upsertThreadOnFirstMessage(threadId, content.slice(0, 50), 'workspace-chat');

    writeSseEvent(sink, { type: 'queue_status', paused: getTaskScheduler().isPaused() });

    const threadMeta = threadStore.getThreadMeta(threadId);
    const effectiveProvider = provider ?? threadMeta?.provider ?? undefined;
    const effectiveModel = model ?? threadMeta?.model ?? undefined;
    if (provider !== undefined || model !== undefined) {
      threadStore.updateThreadModel(threadId, effectiveProvider ?? null, effectiveModel ?? null);
    }

    const allowedWikiId = resolveAllowedWikiId(workspaceStore, workspace.id);
    const workspaceContext = await buildWorkspaceContext(workspace);
    const { agent, systemPrompt } = await getWorkspaceChatAgent(
      workspace.id,
      workspaceContext,
      effectiveProvider,
      effectiveModel,
      allowedWikiId,
    );
    const providerConfig = resolveProviderConfig(effectiveProvider);
    const resolvedProvider = providerConfig.name;
    const resolvedModel = effectiveModel ?? providerConfig.defaultModel!;
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

    const obsConfig = env.observability;
    const store = getObservabilityStore();
    const traceId = store.startTrace({
      threadId,
      provider: resolvedProvider,
      model: resolvedModel,
      source: 'workspace-chat',
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
        resolvedProvider,
        resolvedModel,
      );

      await maybeSummarizeWorkspace(
        sink,
        workspaceStore,
        threadStore,
        workspace,
        createProvider(resolvedProvider, resolvedModel),
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
  } finally {
    getTaskScheduler().scheduleResume();
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
): Promise<void> {
  getTaskScheduler().pause();
  try {
    const workspaceStore = getWorkspaceStore();
    const threadStore = getThreadStore();
    const sink: SseWriter = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    if (getActiveSseWriter(threadId)) {
      writeSseEvent(sink, {
        type: 'stream_error',
        error: 'This workspace has a task running — try again in a moment.',
      });
      return;
    }

    writeSseEvent(sink, { type: 'queue_status', paused: getTaskScheduler().isPaused() });

    const threadMeta = threadStore.getThreadMeta(threadId);
    const effectiveProvider = provider ?? threadMeta?.provider ?? undefined;
    const effectiveModel = model ?? threadMeta?.model ?? undefined;
    if (provider !== undefined || model !== undefined) {
      threadStore.updateThreadModel(threadId, effectiveProvider ?? null, effectiveModel ?? null);
    }

    const allowedWikiId = resolveAllowedWikiId(workspaceStore, workspace.id);
    const workspaceContext = await buildWorkspaceContext(workspace);
    const { agent, systemPrompt } = await getWorkspaceChatAgent(
      workspace.id,
      workspaceContext,
      effectiveProvider,
      effectiveModel,
      allowedWikiId,
    );
    const providerConfig = resolveProviderConfig(effectiveProvider);
    const resolvedProvider = providerConfig.name;
    const resolvedModel = effectiveModel ?? providerConfig.defaultModel!;
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

    const obsConfig = env.observability;
    const store = getObservabilityStore();
    const traceId = store.startTrace({
      threadId,
      provider: resolvedProvider,
      model: resolvedModel,
      source: 'workspace-chat',
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

    setActiveSseWriter(threadId, sink);
    try {
      const eventStream = agent.streamEvents(new Command({ resume: answer }), {
        ...config,
        version: 'v2',
        recursionLimit: env.agent?.recursionLimit ?? 100,
        callbacks: [obsHandler],
        context: {
          provider: effectiveProvider ?? env.defaultProvider,
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
        resolvedProvider,
        resolvedModel,
      );

      await maybeSummarizeWorkspace(
        sink,
        workspaceStore,
        threadStore,
        workspace,
        createProvider(resolvedProvider, resolvedModel),
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
  } finally {
    getTaskScheduler().scheduleResume();
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
): Promise<void> {
  getTaskScheduler().pause();
  try {
    const workspaceStore = getWorkspaceStore();
    const threadStore = getThreadStore();
    const sink: SseWriter = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    if (getActiveSseWriter(threadId)) {
      writeSseEvent(sink, {
        type: 'stream_error',
        error: 'This workspace has a task running — try again in a moment.',
      });
      return;
    }

    writeSseEvent(sink, { type: 'queue_status', paused: getTaskScheduler().isPaused() });

    const threadMeta = threadStore.getThreadMeta(threadId);
    const effectiveProvider = provider ?? threadMeta?.provider ?? undefined;
    const effectiveModel = model ?? threadMeta?.model ?? undefined;
    if (provider !== undefined || model !== undefined) {
      threadStore.updateThreadModel(threadId, effectiveProvider ?? null, effectiveModel ?? null);
    }

    const allowedWikiId = resolveAllowedWikiId(workspaceStore, workspace.id);
    const workspaceContext = await buildWorkspaceContext(workspace);
    const { agent, systemPrompt } = await getWorkspaceChatAgent(
      workspace.id,
      workspaceContext,
      effectiveProvider,
      effectiveModel,
      allowedWikiId,
    );
    const providerConfig = resolveProviderConfig(effectiveProvider);
    const resolvedProvider = providerConfig.name;
    const resolvedModel = effectiveModel ?? providerConfig.defaultModel!;
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

    const obsConfig = env.observability;
    const store = getObservabilityStore();
    const traceId = store.startTrace({
      threadId,
      provider: resolvedProvider,
      model: resolvedModel,
      source: 'workspace-chat',
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
        resolvedProvider,
        resolvedModel,
      );

      await maybeSummarizeWorkspace(
        sink,
        workspaceStore,
        threadStore,
        workspace,
        createProvider(resolvedProvider, resolvedModel),
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
  } finally {
    getTaskScheduler().scheduleResume();
  }
}
