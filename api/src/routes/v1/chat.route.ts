import { Router } from 'express';
import {
  streamChatToSse,
  resumeChatToSse,
  retryChatToSse,
  writeSseEvent,
} from '../../agents/stream-handler.js';
import { getThreadStore } from '../../services/thread-store.js';

export const chatRouter = Router();

function setSseHeaders(res: import('express').Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

chatRouter.post('/:threadId', async (req, res) => {
  const { threadId } = req.params as { threadId: string };
  const { content, provider, model, afterAgent } = req.body as {
    content?: string;
    provider?: string;
    model?: string;
    afterAgent?: boolean;
  };

  if (!threadId || !content?.trim()) {
    res.status(400).json({ error: 'threadId and content are required' });
    return;
  }

  setSseHeaders(res);
  const startedAt = Date.now();

  try {
    req.logger.info(`Inference started for thread`, { threadId, provider, model });
    await streamChatToSse(res, threadId, content.trim(), startedAt, provider, model, afterAgent);
  } catch (err) {
    req.logger.error('Chat stream error', { err });
    writeSseEvent(res, { type: 'stream_error', error: String(err) });
  } finally {
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

  setSseHeaders(res);
  const startedAt = Date.now();

  try {
    await resumeChatToSse(res, threadId, promptId, answer, startedAt, provider, model, afterAgent);
  } catch (err) {
    req.logger.error('HITL resume error', { err });
    writeSseEvent(res, { type: 'stream_error', error: String(err) });
  } finally {
    res.end();
  }
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

  if (!getThreadStore().resolveRetryTarget(threadId)) {
    res.status(400).json({ error: 'Thread has no retryable (failed) turn' });
    return;
  }

  setSseHeaders(res);
  const startedAt = Date.now();

  try {
    await retryChatToSse(res, threadId, startedAt, provider, model, afterAgent);
  } catch (err) {
    req.logger.error('Retry stream error', { err });
    writeSseEvent(res, { type: 'stream_error', error: String(err) });
  } finally {
    res.end();
  }
});
