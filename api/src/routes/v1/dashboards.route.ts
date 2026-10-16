import { Router } from 'express';
import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import {
  listWidgetsHandler,
  createWidgetHandler,
  updateWidgetHandler,
  updateWidgetRawHandler,
  deleteWidgetHandler,
} from './dashboards.handlers.js';

export const dashboardsRouter = Router();

dashboardsRouter.get('/:dashboardId/widgets', async (req: Request, res: Response) => {
  const result = await listWidgetsHandler(env.dashboardRoot, req.params['dashboardId'] as string);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

dashboardsRouter.post('/:dashboardId/widgets', async (req: Request, res: Response) => {
  const result = await createWidgetHandler(
    env.dashboardRoot,
    req.params['dashboardId'] as string,
    req.body,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(201).json(result.data);
});

dashboardsRouter.patch('/:dashboardId/widgets/:id', async (req: Request, res: Response) => {
  const result = await updateWidgetHandler(
    env.dashboardRoot,
    req.params['dashboardId'] as string,
    req.params['id'] as string,
    req.body,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

// PUT, not PATCH — an unconditional whole-file raw overwrite, same convention
// as skills.route.ts's PUT /:name/files/:dir/:basename.
dashboardsRouter.put('/:dashboardId/widgets/:id/raw', async (req: Request, res: Response) => {
  const result = await updateWidgetRawHandler(
    env.dashboardRoot,
    req.params['dashboardId'] as string,
    req.params['id'] as string,
    req.body,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

dashboardsRouter.delete('/:dashboardId/widgets/:id', async (req: Request, res: Response) => {
  const result = await deleteWidgetHandler(
    env.dashboardRoot,
    req.params['dashboardId'] as string,
    req.params['id'] as string,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(204).end();
});
