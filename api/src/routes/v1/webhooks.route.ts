import { Router } from 'express';
import type { Request, Response } from 'express';
import { getWorkspaceStore } from '../../services/workspace-store.js';
import { getThreadStore } from '../../services/thread-store.js';
import { getTaskScheduler } from '../../services/task-scheduler.js';
import { getCronRegistry } from '../../services/cron-registry.js';
import { apiKeyAuth } from '../../middleware/api-key-auth.js';
import { webhookRateLimit } from '../../middleware/webhook-rate-limit.js';
import { createWebhookTaskHandler } from './webhooks.handlers.js';

export const webhooksRouter = Router();

// Rate-limit before auth — even an invalid-key flood should be throttled;
// this is a DoS/brute-force guard, not an auth concern.
webhooksRouter.post('/tasks', webhookRateLimit, apiKeyAuth, (req: Request, res: Response) => {
  const result = createWebhookTaskHandler(
    getWorkspaceStore(),
    getThreadStore(),
    req.body as Record<string, unknown>,
    req.headers['x-workspace-id'] as string | undefined,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  // New work may now be available (a 'ready' + enqueued task) — wake the
  // scheduler and re-sync the cron registry the same way every other
  // task-creating/enqueuing route does.
  getTaskScheduler().wake();
  getCronRegistry().sync(result.data.id);
  res.status(201).json(result.data);
});
