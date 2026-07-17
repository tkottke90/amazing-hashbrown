import { Router } from 'express';
import { streamChatToSse, resumeChatToSse, writeSseEvent } from '../../agents/stream-handler.js';

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
  const { answer, provider, model, afterAgent } = req.body as {
    promptId?: string;
    answer?: string;
    provider?: string;
    model?: string;
    afterAgent?: boolean;
  };

  if (!threadId || answer === undefined) {
    res.status(400).json({ error: 'threadId and answer are required' });
    return;
  }

  setSseHeaders(res);
  const startedAt = Date.now();

  try {
    await resumeChatToSse(res, threadId, answer, startedAt, provider, model, afterAgent);
  } catch (err) {
    req.logger.error('HITL resume error', { err });
    writeSseEvent(res, { type: 'stream_error', error: String(err) });
  } finally {
    res.end();
  }
});
