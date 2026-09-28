import { Router } from 'express';
import { startSseKeepalive } from './sse-keepalive.js';
import {
  streamChatToSse,
  resumeChatToSse,
  retryChatToSse,
  writeSseEvent,
  ClassifiedTurnError,
} from '../../agents/stream-handler.js';
import { stopTurnResponse, type SseWriter } from '../../agents/active-sse-writer.js';
import { getThreadStore } from '../../services/thread-store.js';
import { serializeError } from '../../config/logger.js';
import { respondIfTaskPrompt } from './task-prompt-answer.js';

export const chatRouter = Router();

// An automated task run's thread is a read-only record of what the agent
// did: the only thing a user can do in it is answer the run's own prompts
// (/hitl). A chat message, retry or fork would race the live run on the
// same LangGraph checkpoint. See
// docs/superpowers/specs/2026-09-26-cron-task-triggers-design.md §4.
function rejectIfTaskRunThread(threadId: string, res: import('express').Response): boolean {
  if (getThreadStore().getThreadMeta(threadId)?.type !== 'task') return false;
  res.status(409).json({ error: 'Automated run threads are read-only' });
  return true;
}

function setSseHeaders(res: import('express').Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

// Adapts a raw Express Response into the SseWriter shape writeSseEvent()
// now expects — used only for this route's own catch-block error events;
// the happy-path streaming already builds its own sink inside stream-handler.ts.
function toSink(res: import('express').Response): SseWriter {
  return (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
}

chatRouter.post('/:threadId', async (req, res) => {
  const { threadId } = req.params as { threadId: string };
  const { content, provider, model, afterAgent, attachmentId } = req.body as {
    content?: string;
    provider?: string;
    model?: string;
    afterAgent?: boolean;
    attachmentId?: string;
  };

  if (!threadId || !content?.trim()) {
    res.status(400).json({ error: 'threadId and content are required' });
    return;
  }
  if (rejectIfTaskRunThread(threadId, res)) return;

  setSseHeaders(res);
  const stopKeepalive = startSseKeepalive(res);
  const startedAt = Date.now();

  try {
    req.logger.info(`Inference started for thread`, { threadId, provider, model });
    await streamChatToSse(
      res,
      threadId,
      content.trim(),
      startedAt,
      provider,
      model,
      afterAgent,
      attachmentId,
    );
  } catch (err) {
    req.logger.error('Chat stream error', { err: serializeError(err) });
    const errorCategory = err instanceof ClassifiedTurnError ? err.category : undefined;
    writeSseEvent(toSink(res), {
      type: 'stream_error',
      error: String(err),
      ...(errorCategory ? { errorCategory } : {}),
    });
  } finally {
    stopKeepalive();
    req.logger.info(`Inference completed for thread`, { threadId });
    res.end();
  }
});

chatRouter.post('/:threadId/hitl', async (req, res) => {
  const { threadId } = req.params as { threadId: string };
  const { promptId, answer, provider, model, afterAgent } = req.body as {
    promptId?: string;
    answer?: string;
    provider?: string;
    model?: string;
    afterAgent?: boolean;
  };

  if (!threadId || answer === undefined || !promptId) {
    res.status(400).json({ error: 'threadId, promptId, and answer are required' });
    return;
  }

  // An Inbox task run's prompt is answered from its run thread through this
  // route — re-queue the task rather than resuming it as a chat turn.
  if (respondIfTaskPrompt(req, res, { threadId, promptId, answer })) return;

  setSseHeaders(res);
  const stopKeepalive = startSseKeepalive(res);
  const startedAt = Date.now();

  try {
    await resumeChatToSse(res, threadId, promptId, answer, startedAt, provider, model, afterAgent);
  } catch (err) {
    req.logger.error('HITL resume error', { err: serializeError(err) });
    const errorCategory = err instanceof ClassifiedTurnError ? err.category : undefined;
    writeSseEvent(toSink(res), {
      type: 'stream_error',
      error: String(err),
      ...(errorCategory ? { errorCategory } : {}),
    });
  } finally {
    stopKeepalive();
    res.end();
  }
});

// Explicit cancel — see docs/superpowers/specs/2026-09-21-interactive-chat-cancel-design.md.
// Plain JSON endpoint, not SSE: the turn it targets is a separate,
// already-open request/response; this one just aborts it and returns.
chatRouter.post('/:threadId/stop', (req, res) => {
  const { threadId } = req.params as { threadId: string };
  const { status, body } = stopTurnResponse(threadId);
  res.status(status).json(body);
});

chatRouter.post('/:threadId/retry', async (req, res) => {
  const { threadId } = req.params as { threadId: string };
  const { provider, model, afterAgent } = req.body as {
    provider?: string;
    model?: string;
    afterAgent?: boolean;
  };

  if (!threadId) {
    res.status(400).json({ error: 'threadId is required' });
    return;
  }

  if (rejectIfTaskRunThread(threadId, res)) return;

  if (!getThreadStore().resolveRetryTarget(threadId)) {
    res.status(400).json({ error: 'Thread has no retryable (failed) turn' });
    return;
  }

  setSseHeaders(res);
  const stopKeepalive = startSseKeepalive(res);
  const startedAt = Date.now();

  try {
    await retryChatToSse(res, threadId, startedAt, provider, model, afterAgent);
  } catch (err) {
    req.logger.error('Retry stream error', { err: serializeError(err) });
    const errorCategory = err instanceof ClassifiedTurnError ? err.category : undefined;
    writeSseEvent(toSink(res), {
      type: 'stream_error',
      error: String(err),
      ...(errorCategory ? { errorCategory } : {}),
    });
  } finally {
    stopKeepalive();
    res.end();
  }
});
