import { Router } from 'express';
import type { Request, Response } from 'express';
import { getUsageStore } from '../../services/usage.js';
import type { UsageFilters } from '@tkottke90/observability';

export const usageRouter = Router();

usageRouter.get('/', (req: Request, res: Response) => {
  const { from, to, provider, model } = req.query as Record<string, string | undefined>;

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const defaultFrom = thirtyDaysAgo.toISOString().slice(0, 10);

  const filters: UsageFilters = {
    from: from ?? defaultFrom,
    to: to ?? todayStr,
  };
  if (provider) filters.provider = provider;
  if (model) filters.model = model;

  const store = getUsageStore();
  const rows = store.queryUsage(filters);

  const totals = rows.reduce(
    (acc, row) => ({
      inputTokens: acc.inputTokens + row.inputTokens,
      outputTokens: acc.outputTokens + row.outputTokens,
      estimatedCost: acc.estimatedCost + row.estimatedCost,
    }),
    { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
  );

  res.json({ from: filters.from, to: filters.to, rows, totals });
});
