import { Router } from 'express';
import type { Request, Response } from 'express';
import { getObservabilityStore } from '../../services/observability.js';
import { getThreadStore } from '../../services/thread-store.js';
import { getScenarioSourceHandler } from './traces.handlers.js';
import type { TraceFilters } from '@tkottke90/observability';

export const tracesRouter = Router();

tracesRouter.get('/', (req: Request, res: Response) => {
  const { threadId, taskId, since, limit, offset } = req.query as Record<
    string,
    string | undefined
  >;

  const filters: TraceFilters = {};
  if (threadId) filters.threadId = threadId;
  if (taskId) filters.taskId = taskId;
  if (since) filters.since = since;
  if (limit) filters.limit = parseInt(limit, 10);
  if (offset) filters.offset = parseInt(offset, 10);

  const store = getObservabilityStore();
  const summaries = store.find(filters);
  res.json(summaries);
});

tracesRouter.get('/:traceId/summary', (req: Request, res: Response) => {
  const { traceId } = req.params as { traceId: string };
  const store = getObservabilityStore();
  const summary = store.findById(traceId);
  if (!summary) {
    res.status(404).json({ error: 'Trace not found' });
    return;
  }
  res.json(summary);
});

// Joins this trace's spans with its linked thread's full message history
// into scenario-authoring-ready data (see traces.handlers.ts) — used by
// bin/eval-from-trace.ts (over HTTP, no local filesystem/DB access needed)
// and, in future, an in-app "capture as eval scenario" feature.
tracesRouter.get('/:traceId/scenario-source', (req: Request, res: Response) => {
  const { traceId } = req.params as { traceId: string };
  const result = getScenarioSourceHandler(getObservabilityStore(), getThreadStore(), traceId);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

tracesRouter.get('/:traceId', (req: Request, res: Response) => {
  const { traceId } = req.params as { traceId: string };
  const store = getObservabilityStore();
  const trace = store.getTrace(traceId);
  if (!trace) {
    res.status(404).json({ error: 'Trace not found' });
    return;
  }
  res.json(trace);
});
