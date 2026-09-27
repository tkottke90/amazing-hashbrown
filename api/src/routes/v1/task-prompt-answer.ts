import type { Request, Response } from 'express';
import { getWorkspaceStore } from '../../services/workspace-store.js';
import { getThreadStore } from '../../services/thread-store.js';
import { getTaskScheduler } from '../../services/task-scheduler.js';
import { writeSseEvent } from '../../agents/stream-handler.js';
import { serializeError } from '../../config/logger.js';
import { answerTaskPrompt } from './tasks.handlers.js';

// Shared by every /hitl route: if the answered prompt was raised by an
// automated task run, hand it to answerTaskPrompt (which re-queues the task
// so the scheduler — not this HTTP request — drives the agent forward) and
// close the SSE response the client is waiting on. Returns false for an
// ordinary chat prompt, leaving the route to resume its own interactive
// turn. The response is still SSE so the client's existing /hitl reader
// needs no task-specific branch.
export function respondIfTaskPrompt(
  req: Request,
  res: Response,
  input: { threadId: string; promptId: string; answer: string },
): boolean {
  let outcome: ReturnType<typeof answerTaskPrompt>;
  try {
    outcome = answerTaskPrompt(getWorkspaceStore(), getThreadStore(), input);
  } catch (err) {
    req.logger.error('HITL task re-enqueue error', { err: serializeError(err) });
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    writeSseEvent((event) => res.write(`data: ${JSON.stringify(event)}\n\n`), {
      type: 'stream_error',
      error: String(err),
    });
    res.end();
    return true;
  }
  if (outcome === 'not_task') return false;

  if (outcome === 'resumed') getTaskScheduler().wake();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'stream_done', durationMs: 0 })}\n\n`);
  res.end();
  return true;
}
