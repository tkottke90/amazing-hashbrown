import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  streamWorkspaceChatToSse,
  resumeWorkspaceChatToSse,
  retryWorkspaceChatToSse,
} from '../../agents/workspace-chat-stream-handler.js';
import { writeSseEvent } from '../../agents/stream-handler.js';
import type { SseWriter } from '../../agents/active-sse-writer.js';
import { maybeSummarizeWorkspace } from '../../agents/workspace-summarizer.js';
import { resolveHitlPrompt } from '../../agents/thread-message-writer.js';
import { createProvider } from '../../services/provider-factory.js';
import { getWorkspaceStore } from '../../services/workspace-store.js';
import { getThreadStore } from '../../services/thread-store.js';
import { getTaskScheduler } from '../../services/task-scheduler.js';
import { getThreadHandler } from './threads.handlers.js';
import { serializeError } from '../../config/logger.js';

// Mounted at workspacesRouter.use('/:id/chat', workspaceChatRouter) — :id is
// defined on the parent router, so this one needs mergeParams to see it.
export const workspaceChatRouter = Router({ mergeParams: true });

function setSseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

// Adapts a raw Express Response into the SseWriter shape writeSseEvent()
// now expects — used only for this route's own catch-block error events.
function toSink(res: Response): SseWriter {
  return (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// Resolves the workspace for :id and confirms :threadId is (or can become)
// its one chat thread. Returns null and has already written an error
// response when resolution fails.
function resolveWorkspaceForThread(req: Request, res: Response) {
  const { id, threadId } = req.params as { id: string; threadId: string };
  const workspace = getWorkspaceStore().getWorkspace(id);
  if (!workspace) {
    res.status(404).json({ error: `Workspace ${id} not found` });
    return null;
  }
  if (workspace.threadId && workspace.threadId !== threadId) {
    res.status(400).json({ error: "threadId does not match this workspace's assigned thread" });
    return null;
  }
  return workspace;
}

workspaceChatRouter.get('/:threadId', (req: Request, res: Response) => {
  const { threadId } = req.params as { threadId: string };
  const workspace = resolveWorkspaceForThread(req, res);
  if (!workspace) return;

  const showErrors = req.query['showErrors'] === 'true';
  const result = getThreadHandler(getThreadStore(), threadId, {
    showErrors,
    afterMessageId: workspace.lastSummarizedMessageId ?? undefined,
  });
  if (!result.ok) {
    // A workspace-chat thread not existing yet (pre-first-message) is not an
    // error — return an empty history rather than propagating the 404.
    res.json({ messages: [], summaryPath: workspace.summaryPath, summarizedAt: null });
    return;
  }

  const summarizedAt = workspace.lastSummarizedMessageId
    ? (getThreadStore().getMessage(threadId, workspace.lastSummarizedMessageId)?.createdAt ?? null)
    : null;

  res.json({ ...result.data, summaryPath: workspace.summaryPath, summarizedAt });
});

workspaceChatRouter.post('/:threadId', async (req: Request, res: Response) => {
  const { threadId } = req.params as { threadId: string };
  const { content, provider, model, afterAgent } = req.body as {
    content?: string;
    provider?: string;
    model?: string;
    afterAgent?: boolean;
  };

  if (!content?.trim()) {
    res.status(400).json({ error: 'content is required' });
    return;
  }

  const workspace = resolveWorkspaceForThread(req, res);
  if (!workspace) return;

  setSseHeaders(res);
  const startedAt = Date.now();
  try {
    await streamWorkspaceChatToSse(
      res,
      workspace,
      threadId,
      content.trim(),
      startedAt,
      provider,
      model,
      afterAgent,
    );
  } catch (err) {
    req.logger.error('Workspace chat stream error', { err: serializeError(err) });
    writeSseEvent(toSink(res), { type: 'stream_error', error: String(err) });
  } finally {
    res.end();
  }
});

workspaceChatRouter.post('/:threadId/hitl', async (req: Request, res: Response) => {
  const { threadId } = req.params as { threadId: string };
  const { promptId, answer, provider, model, afterAgent } = req.body as {
    promptId?: string;
    answer?: string;
    provider?: string;
    model?: string;
    afterAgent?: boolean;
  };

  if (answer === undefined || !promptId) {
    res.status(400).json({ error: 'promptId and answer are required' });
    return;
  }

  const workspace = resolveWorkspaceForThread(req, res);
  if (!workspace) return;

  // A prompt raised by an automated task run (task-execution.ts) carries
  // taskId in its payload — re-enqueue the task instead of resuming an
  // interactive turn, so the scheduler (not this HTTP request) drives the
  // agent forward. See docs/superpowers/specs/2026-08-27-automated-task-execution-design.md §6.
  const existingPrompt = getThreadStore().getMessage(threadId, promptId);
  const taskId = (existingPrompt?.payload as Record<string, unknown> | undefined)?.[
    'taskId'
  ] as string | undefined;

  if (taskId) {
    setSseHeaders(res);
    try {
      resolveHitlPrompt(getThreadStore(), threadId, promptId, answer);
      getWorkspaceStore().patchTask(taskId, {
        status: 'ready',
        assignedTo: 'agent',
        resumeAnswer: answer,
      });
      getWorkspaceStore().enqueueTask(taskId);
      getTaskScheduler().wake();
      res.write(`data: ${JSON.stringify({ type: 'stream_done', durationMs: 0 })}\n\n`);
    } catch (err) {
      req.logger.error('Workspace chat HITL task re-enqueue error', { err: serializeError(err) });
      writeSseEvent(toSink(res), { type: 'stream_error', error: String(err) });
    } finally {
      res.end();
    }
    return;
  }

  setSseHeaders(res);
  const startedAt = Date.now();
  try {
    await resumeWorkspaceChatToSse(
      res,
      workspace,
      threadId,
      promptId,
      answer,
      startedAt,
      provider,
      model,
      afterAgent,
    );
  } catch (err) {
    req.logger.error('Workspace chat HITL resume error', { err: serializeError(err) });
    writeSseEvent(toSink(res), { type: 'stream_error', error: String(err) });
  } finally {
    res.end();
  }
});

workspaceChatRouter.post('/:threadId/retry', async (req: Request, res: Response) => {
  const { threadId } = req.params as { threadId: string };
  const { provider, model, afterAgent } = req.body as {
    provider?: string;
    model?: string;
    afterAgent?: boolean;
  };

  const workspace = resolveWorkspaceForThread(req, res);
  if (!workspace) return;

  if (!getThreadStore().resolveRetryTarget(threadId)) {
    res.status(400).json({ error: 'Thread has no retryable (failed) turn' });
    return;
  }

  setSseHeaders(res);
  const startedAt = Date.now();
  try {
    await retryWorkspaceChatToSse(res, workspace, threadId, startedAt, provider, model, afterAgent);
  } catch (err) {
    req.logger.error('Workspace chat retry stream error', { err: serializeError(err) });
    writeSseEvent(toSink(res), { type: 'stream_error', error: String(err) });
  } finally {
    res.end();
  }
});

// On-demand "Summarise" button — plain request/response, not SSE. The
// automatic in-turn path (summarizing_start/summarizing_end) is scoped to
// the live chat stream; this path gives the button its own request cycle
// with a simple loading state on the frontend instead of a second
// concurrent SSE connection per workspace.
workspaceChatRouter.post('/:threadId/summarize', async (req: Request, res: Response) => {
  const workspace = resolveWorkspaceForThread(req, res);
  if (!workspace) return;

  const { provider, model } = req.body as { provider?: string; model?: string };
  const threadStore = getThreadStore();
  const threadMeta = workspace.threadId ? threadStore.getThreadMeta(workspace.threadId) : null;
  const effectiveProvider = provider ?? threadMeta?.provider ?? undefined;
  const effectiveModel = model ?? threadMeta?.model ?? undefined;

  try {
    await maybeSummarizeWorkspace(
      undefined,
      getWorkspaceStore(),
      threadStore,
      workspace,
      createProvider(effectiveProvider, effectiveModel),
      effectiveProvider,
      effectiveModel,
      { force: true },
    );
  } catch (err) {
    req.logger.error('Workspace chat on-demand summarize error', { err: serializeError(err) });
    res.status(500).json({ error: 'Failed to summarize workspace chat' });
    return;
  }

  const refreshed = getWorkspaceStore().getWorkspace(workspace.id);
  res.json({
    summaryPath: refreshed?.summaryPath ?? null,
    summarizedAt:
      refreshed?.lastSummarizedMessageId && refreshed.threadId
        ? (threadStore.getMessage(refreshed.threadId, refreshed.lastSummarizedMessageId)
            ?.createdAt ?? null)
        : null,
  });
});
