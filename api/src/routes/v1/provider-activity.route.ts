import { Router } from 'express';
import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import { getProviderQueue } from '../../services/provider-queue.js';
import { getProviderActivityHandler } from './provider-activity.handlers.js';

export const providerActivityRouter = Router();

providerActivityRouter.get('/', (_req: Request, res: Response) => {
  const providerNames = env.providers.map((p) => p.name);
  const result = getProviderActivityHandler(getProviderQueue(), providerNames);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});
