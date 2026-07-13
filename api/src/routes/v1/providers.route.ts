import { Router } from 'express';
import { env } from '../../config/env.js';
import { listModels } from '../../services/provider-factory.js';

export const providersRouter = Router();

providersRouter.get('/', async (_req, res) => {
  const providers = env.providers;

  const results = await Promise.all(
    providers.map(async (p) => ({
      name: p.name,
      type: p.type,
      defaultModel: p.defaultModel,
      models: await listModels(p),
    })),
  );

  res.json({ providers: results });
});
