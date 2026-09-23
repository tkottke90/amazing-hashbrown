import { Router } from 'express';
import type { Request, Response } from 'express';
import { getToolFrictionStore } from '../../services/tool-friction.js';
import { getShellAuditStore } from '../../services/shell-audit.js';
import {
  getToolFrictionHandler,
  getFileToolAdoptionHandler,
  type HandlerFailure,
} from './metrics.handlers.js';

// Owns the /metrics namespace rather than being named after any one metric
// it exposes — a future metrics endpoint is "add a handler here", not
// "add another one-off router file". No UI reads these; they're for direct
// pulls (curl, a script, a future dashboard) only.
export const metricsRouter = Router();

function sendFailure(res: Response, failure: HandlerFailure): void {
  res.status(failure.status).json({ error: failure.error });
}

metricsRouter.get('/tool-friction', (req: Request, res: Response) => {
  const { from, to, toolName } = req.query as Record<string, string | undefined>;
  const result = getToolFrictionHandler(getToolFrictionStore(), { from, to, toolName });
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json(result.data);
});

metricsRouter.get('/file-tool-adoption', (req: Request, res: Response) => {
  const { from, to } = req.query as Record<string, string | undefined>;
  const result = getFileToolAdoptionHandler(getShellAuditStore(), { from, to });
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json(result.data);
});
