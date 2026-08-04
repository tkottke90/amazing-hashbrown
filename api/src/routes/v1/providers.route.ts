import { Router } from 'express';
import { env } from '../../config/env.js';
import { listModels } from '../../services/provider-factory.js';

export const providersRouter = Router();

providersRouter.get('/', async (_req, res) => {
  const results = await Promise.all(
    env.providers.map(async (p) => {
      const liveIds = await listModels(p);
      const pricingMap = new Map((p.models ?? []).map((m) => [m.id, m]));
      return {
        name: p.name,
        type: p.type,
        defaultModel: p.defaultModel,
        models: liveIds.map((id) => {
          const pricing = pricingMap.get(id);
          return pricing
            ? {
                id,
                inputPricePerM: pricing.inputPricePerM,
                outputPricePerM: pricing.outputPricePerM,
              }
            : { id };
        }),
      };
    }),
  );

  res.json({ providers: results });
});
