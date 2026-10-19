import { Router } from 'express';
import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import {
  listWidgetsHandler,
  createWidgetHandler,
  updateWidgetHandler,
  reorderWidgetHandler,
  updateWidgetContentHandler,
  updateWidgetRawHandler,
  deleteWidgetHandler,
  listDashboardsHandler,
  createDashboardHandler,
  updateDashboardHandler,
  deleteDashboardHandler,
} from './dashboards.handlers.js';

export const dashboardsRouter = Router();

dashboardsRouter.get('/', async (_req: Request, res: Response) => {
  const result = await listDashboardsHandler(env.dashboardRoot);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

dashboardsRouter.post('/', async (req: Request, res: Response) => {
  const result = await createDashboardHandler(env.dashboardRoot, req.body);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(201).json(result.data);
});

dashboardsRouter.patch('/:dashboardId', async (req: Request, res: Response) => {
  const result = await updateDashboardHandler(
    env.dashboardRoot,
    req.params['dashboardId'] as string,
    req.body,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

dashboardsRouter.delete('/:dashboardId', async (req: Request, res: Response) => {
  const result = await deleteDashboardHandler(
    env.dashboardRoot,
    req.params['dashboardId'] as string,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(204).end();
});

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

// Reorder (ADR-0008) — the drag-and-drop splice, distinct from the
// full-replace PATCH above (which already covers resize, since that's just
// `w`/`h` on the same body).
dashboardsRouter.patch('/:dashboardId/widgets/:id/reorder', async (req: Request, res: Response) => {
  const result = await reorderWidgetHandler(
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

// Agent/CLI content-merge write (D2/D3/ADR-0004) — a partial Widget Payload
// merge onto the existing widget, distinct from the full-replace PATCH
// above. `source` is hardcoded here, never read from the request body
// (ADR-0005); the agent tool calls `updateWidgetContentHandler` directly,
// in-process, bypassing this route entirely.
dashboardsRouter.patch('/:dashboardId/widgets/:id/content', async (req: Request, res: Response) => {
  const result = await updateWidgetContentHandler(
    env.dashboardRoot,
    req.params['dashboardId'] as string,
    req.params['id'] as string,
    req.body,
    'agent',
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
