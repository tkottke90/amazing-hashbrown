import { Router } from 'express';
import type { Request, Response } from 'express';
import { getThreadStore } from '../../services/thread-store.js';
import { getCheckpointer } from '../../agents/chat-agent.js';
import { createProvider } from '../../services/provider-factory.js';
import {
  listThreadsHandler,
  getThreadHandler,
  renameThreadHandler,
  deleteThreadHandler,
  forkThreadHandler,
  generateTitleHandler,
  getAfterAgentStatusHandler,
  generateThreadReportHandler,
} from './threads.handlers.js';

export const threadsRouter = Router();

threadsRouter.get('/', (_req: Request, res: Response) => {
  res.json(listThreadsHandler(getThreadStore()));
});

threadsRouter.get('/:id', (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { showErrors } = req.query as { showErrors?: string };
  const result = getThreadHandler(getThreadStore(), id, { showErrors: showErrors === 'true' });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

threadsRouter.get('/:id/after-agent-status', (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const result = getAfterAgentStatusHandler(getThreadStore(), id);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

threadsRouter.get('/:id/report', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const result = await generateThreadReportHandler(getThreadStore(), id);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(result.data.html);
});

threadsRouter.patch('/:id', (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { title } = req.body as { title?: string };
  if (typeof title !== 'string') {
    res.status(400).json({ error: 'title is required' });
    return;
  }
  const result = renameThreadHandler(getThreadStore(), id, title);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

threadsRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const result = await deleteThreadHandler(getThreadStore(), getCheckpointer(), id);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(204).end();
});

threadsRouter.post('/:id/fork', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { atSeq } = req.body as { atSeq?: number };
  if (typeof atSeq !== 'number') {
    res.status(400).json({ error: 'atSeq is required' });
    return;
  }
  const result = await forkThreadHandler(getThreadStore(), getCheckpointer(), id, atSeq);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

threadsRouter.post('/:id/generate-title', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { provider, model: modelName } = req.body as { provider?: string; model?: string };

  let model;
  try {
    model = createProvider(provider, modelName);
  } catch (err) {
    res.status(500).json({
      error: `No provider available: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const result = await generateTitleHandler(getThreadStore(), model, id, provider, modelName);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});
