import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  streamWorkspaceChatToSse,
  resumeWorkspaceChatToSse,
  retryWorkspaceChatToSse,
  buildWorkspaceContext,
  resolveAllowedWikiId,
} from '../../agents/workspace-chat-stream-handler.js';
import { writeSseEvent, ClassifiedTurnError } from '../../agents/stream-handler.js';
import { stopTurnResponse, type SseWriter } from '../../agents/active-sse-writer.js';
import { maybeSummarizeWorkspace } from '../../agents/workspace-summarizer.js';
import { resolveHitlPrompt } from '../../agents/thread-message-writer.js';
import { getWorkspaceChatAgent } from '../../agents/chat-agent.js';
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

  const result = getThreadHandler(getThreadStore(), threadId, {
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
    const errorCategory = err instanceof ClassifiedTurnError ? err.category : undefined;
    writeSseEvent(toSink(res), {
      type: 'stream_error',
      error: String(err),
      ...(errorCategory ? { errorCategory } : {}),
    });
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
  const taskId = (existingPrompt?.payload as Record<string, unknown> | undefined)?.['taskId'] as
    string | undefined;

  if (taskId) {
    setSseHeaders(res);
    try {
      const store = getWorkspaceStore();
      const task = store.getTask(taskId);
      const parked = store.listQueue().find((e) => e.taskId === taskId && e.status === 'paused');

      // A task that isn't actually waiting on an answer anymore (already
      // done/failed/cancelled/running, or deleted) means this prompt is
      // stale — most often an interrupt finalizeTurn found in the shared
      // thread's checkpoint state after the task's own run had already
      // completed via complete_task in the same stream (see
      // stream-handler.ts's discardInterrupt, which now stops that prompt
      // from ever being dispatched in the first place — this is the
      // belt-and-suspenders half, for a stale prompt that predates that fix
      // or an answer that arrives late for any other reason). Resolve the
      // prompt for bookkeeping so it stops rendering as a live card, but
      // never let a stale answer reopen or re-run a task that has already
      // moved on — that's exactly what let a duplicate run clobber an
      // already-'done' task's status.
      if (!parked && task?.status !== 'waiting_on_user') {
        resolveHitlPrompt(getThreadStore(), threadId, promptId, answer);
        res.write(`data: ${JSON.stringify({ type: 'stream_done', durationMs: 0 })}\n\n`);
        return;
      }

      resolveHitlPrompt(getThreadStore(), threadId, promptId, answer);
      store.patchTask(taskId, {
        status: 'ready',
        assignedTo: 'agent',
        resumeAnswer: answer,
      });
      // Reactivate the row task-execution.ts parked (parkQueueEntryForHitl())
      // at ITS ORIGINAL queue position, rather than enqueueTask()'s always-
      // append-to-the-back — a fresh row here is exactly what lets every
      // sibling task still pending in this scope queue-jump a task that
      // already started and is merely waiting on this answer.
      if (parked) {
        store.resumePausedEntry(parked.id);
      } else {
        // Defensive fallback — task.status === 'waiting_on_user' (checked
        // above) confirms this task really is waiting on this exact answer,
        // just missing its parked row somehow; don't leave it un-resumable.
        store.enqueueTask(taskId);
      }
      getTaskScheduler().wake();
      res.write(`data: ${JSON.stringify({ type: 'stream_done', durationMs: 0 })}\n\n`);
    } catch (err) {
      req.logger.error('Workspace chat HITL task re-enqueue error', { err: serializeError(err) });
      const errorCategory = err instanceof ClassifiedTurnError ? err.category : undefined;
      writeSseEvent(toSink(res), {
        type: 'stream_error',
        error: String(err),
        ...(errorCategory ? { errorCategory } : {}),
      });
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
    const errorCategory = err instanceof ClassifiedTurnError ? err.category : undefined;
    writeSseEvent(toSink(res), {
      type: 'stream_error',
      error: String(err),
      ...(errorCategory ? { errorCategory } : {}),
    });
  } finally {
    res.end();
  }
});

// Explicit cancel — see docs/superpowers/specs/2026-09-21-interactive-chat-cancel-design.md.
// Plain JSON endpoint, not SSE: the turn it targets is a separate,
// already-open request/response; this one just aborts it and returns.
// Resolves the workspace first (matching every other route in this file)
// so a stop request against an unresolvable workspace 404s consistently,
// rather than silently 409ing as if a turn simply weren't running.
workspaceChatRouter.post('/:threadId/stop', (req: Request, res: Response) => {
  const { threadId } = req.params as { threadId: string };
  if (!resolveWorkspaceForThread(req, res)) return;
  const { status, body } = stopTurnResponse(threadId);
  res.status(status).json(body);
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
    const errorCategory = err instanceof ClassifiedTurnError ? err.category : undefined;
    writeSseEvent(toSink(res), {
      type: 'stream_error',
      error: String(err),
      ...(errorCategory ? { errorCategory } : {}),
    });
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
    const workspaceContext = await buildWorkspaceContext(workspace);
    const allowedWikiId = resolveAllowedWikiId(getWorkspaceStore(), workspace.id);
    const { agent } = await getWorkspaceChatAgent(
      workspace.id,
      workspaceContext,
      effectiveProvider,
      effectiveModel,
      allowedWikiId,
    );

    await maybeSummarizeWorkspace(
      undefined,
      getWorkspaceStore(),
      threadStore,
      workspace,
      agent,
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
