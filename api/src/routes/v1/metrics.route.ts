import { Router } from 'express';
import type { Request, Response } from 'express';
import { listMetricsHandler, previewMetricHandler } from './metrics.handlers.js';

export const metricsRouter = Router();

// The System Widget Metric catalog (ADR-0013) — ids/labels/displayTypes
// only, never a resolved value. The drawer's Metric picker reads this.
metricsRouter.get('/', (_req: Request, res: Response) => {
  const result = listMetricsHandler();
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

// On-demand resolution for the drawer's live preview, before a System
// Widget is saved. Never persisted — nothing writes this result anywhere.
metricsRouter.get('/:id/value', async (req: Request, res: Response) => {
  const result = await previewMetricHandler(req.params['id'] as string);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});
