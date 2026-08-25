import { Router } from 'express';
import type { Request, Response } from 'express';
import { getWorkspaceStore } from '../../services/workspace-store.js';
import { getTaskScheduler } from '../../services/task-scheduler.js';
import { triggerWebhookHandler } from './triggers.handlers.js';

export const triggersRouter = Router();

triggersRouter.post('/webhook/:token', (req: Request, res: Response) => {
  const result = triggerWebhookHandler(getWorkspaceStore(), req.params['token'] as string);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  // New work is available — let the (event-driven) scheduler know so it can
  // pick it up immediately rather than waiting on the next unrelated trigger.
  getTaskScheduler().wake();
  res.status(201).json(result.data);
});
