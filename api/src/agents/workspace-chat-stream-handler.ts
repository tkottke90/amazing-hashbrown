import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { Command } from '@langchain/langgraph';
import { logger, serializeError } from '../config/logger.js';
import { getWorkspaceChatAgent, type WorkspaceChatContext } from './chat-agent.js';
import { setActiveSseWriter, clearActiveSseWriter } from './active-sse-writer.js';
import { writeSseEvent, pipeEvents, finalizeTurn, drainAndRecordWikiUpdates } from './stream-handler.js';
import { env } from '../config/env.js';
import { getObservabilityStore } from '../services/observability.js';
import { getThreadStore } from '../services/thread-store.js';
import { getTaskScheduler } from '../services/task-scheduler.js';
import { getWikiRegistry } from '../services/wiki.js';
import { createProvider } from '../services/provider-factory.js';
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
// once per turn and threaded into the agent's tool calls via
// config.configurable.allowedWikiId (see wiki-create-page.tool.ts /
// wiki-update-page.tool.ts). undefined for a non-project workspace, meaning
// unrestricted, matching today's global-chat behavior.
function resolveAllowedWikiId(store: WorkspaceStore, workspaceId: string): string | undefined {
  const project = store.getProject(workspaceId);
  if (!project) return undefined;
  return store.getWorkspace(workspaceId)?.wikiId ?? undefined;
}

async function buildWorkspaceContext(workspace: Workspace): Promise<WorkspaceChatContext> {
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
    threadStore.upsertThreadOnFirstMessage(threadId, content.slice(0, 50), 'workspace-chat');

    writeSseEvent(res, { type: 'queue_status', paused: getTaskScheduler().isPaused() });

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
    );
    const config = {
      configurable: {
        thread_id: threadId,
        workspaceId: workspace.id,
        ...(allowedWikiId !== undefined ? { allowedWikiId } : {}),
      },
    };
    const msgId = randomUUID();
    const turnSentAt = new Date().toISOString();

    const userSeq = recordUserMessage(threadStore, threadId, randomUUID(), content, turnSentAt);

    drainAndRecordWikiUpdates(res, threadStore, threadId);

    const obsConfig = env.observability;
    const store = getObservabilityStore();
    const traceId = store.startTrace({
      threadId,
      provider: effectiveProvider ?? env.defaultProvider,
      model: effectiveModel ?? '',
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
      effectiveProvider,
      effectiveModel,
    );

    setActiveSseWriter(threadId, (event) => {
      writeSseEvent(res, event);
    });
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
        obsHandler,
        effectiveProvider,
        effectiveModel,
      );

      await maybeSummarizeWorkspace(
        res,
        workspaceStore,
        threadStore,
        workspace,
        createProvider(effectiveProvider, effectiveModel),
        effectiveProvider,
        effectiveModel,
      );
    } catch (err) {
      if ((err as Error).name === 'GraphRecursionError') {
        const msg =
          'I ran out of steps before finishing. You can reply with instructions to continue, or ask me to summarize what I accomplished so far.';
        finalizeAssistant(threadStore, threadId, msgId, msg, '', turnSentAt, null);
        writeSseEvent(res, { type: 'text_delta', messageId: msgId, delta: msg });
        writeSseEvent(res, { type: 'stream_done', durationMs: Date.now() - startedAt });
        return;
      }
      failAssistant(threadStore, threadId, msgId, '', turnSentAt);
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

    writeSseEvent(res, { type: 'queue_status', paused: getTaskScheduler().isPaused() });

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
    );
    const config = {
      configurable: {
        thread_id: threadId,
        workspaceId: workspace.id,
        ...(allowedWikiId !== undefined ? { allowedWikiId } : {}),
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
      writeSseEvent(res, { type: 'stream_error', error: 'Failed to record HITL answer' });
      return;
    }

    drainAndRecordWikiUpdates(res, threadStore, threadId);

    const obsConfig = env.observability;
    const store = getObservabilityStore();
    const traceId = store.startTrace({
      threadId,
      provider: effectiveProvider ?? env.defaultProvider,
      model: effectiveModel ?? '',
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
      effectiveProvider,
      effectiveModel,
    );

    setActiveSseWriter(threadId, (event) => {
      writeSseEvent(res, event);
    });
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
        obsHandler,
        effectiveProvider,
        effectiveModel,
      );

      await maybeSummarizeWorkspace(
        res,
        workspaceStore,
        threadStore,
        workspace,
        createProvider(effectiveProvider, effectiveModel),
        effectiveProvider,
        effectiveModel,
      );
    } catch (err) {
      if ((err as Error).name === 'GraphRecursionError') {
        const msg =
          'I ran out of steps before finishing. You can reply with instructions to continue, or ask me to summarize what I accomplished so far.';
        finalizeAssistant(threadStore, threadId, msgId, msg, '', turnSentAt, null);
        writeSseEvent(res, { type: 'text_delta', messageId: msgId, delta: msg });
        writeSseEvent(res, { type: 'stream_done', durationMs: Date.now() - startedAt });
        return;
      }
      failAssistant(threadStore, threadId, msgId, '', turnSentAt);
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

    writeSseEvent(res, { type: 'queue_status', paused: getTaskScheduler().isPaused() });

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
    );
    const config = {
      configurable: {
        thread_id: threadId,
        workspaceId: workspace.id,
        ...(allowedWikiId !== undefined ? { allowedWikiId } : {}),
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
      effectiveProvider,
      effectiveModel,
    );

    drainAndRecordWikiUpdates(res, threadStore, threadId);

    const obsConfig = env.observability;
    const store = getObservabilityStore();
    const traceId = store.startTrace({
      threadId,
      provider: effectiveProvider ?? env.defaultProvider,
      model: effectiveModel ?? '',
      source: 'workspace-chat',
      systemPrompt,
    });
    const obsHandler = new ObservabilityCallbackHandler(
      traceId,
      store,
      obsConfig.spanOutputPreviewChars,
    );

    setActiveSseWriter(threadId, (event) => {
      writeSseEvent(res, event);
    });
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
        obsHandler,
        effectiveProvider,
        effectiveModel,
      );

      await maybeSummarizeWorkspace(
        res,
        workspaceStore,
        threadStore,
        workspace,
        createProvider(effectiveProvider, effectiveModel),
        effectiveProvider,
        effectiveModel,
      );
    } catch (err) {
      if ((err as Error).name === 'GraphRecursionError') {
        const msg =
          'I ran out of steps before finishing. You can reply with instructions to continue, or ask me to summarize what I accomplished so far.';
        finalizeAssistant(threadStore, threadId, msgId, msg, '', turnSentAt, null);
        writeSseEvent(res, { type: 'text_delta', messageId: msgId, delta: msg });
        writeSseEvent(res, { type: 'stream_done', durationMs: Date.now() - startedAt });
        return;
      }
      failAssistant(threadStore, threadId, msgId, '', turnSentAt);
      throw err;
    } finally {
      clearActiveSseWriter(threadId);
    }
  } finally {
    getTaskScheduler().scheduleResume();
  }
}
