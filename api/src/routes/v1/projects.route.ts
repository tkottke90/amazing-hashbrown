import { Router } from 'express';
import type { Request, Response } from 'express';
import { getWorkspaceStore } from '../../services/workspace-store.js';
import {
  listProjectsHandler,
  getProjectHandler,
  createProjectHandler,
  patchProjectHandler,
  closeProjectHandler,
  snapshotProjectHandler,
  completeCloseProjectHandler,
} from './projects.handlers.js';

export const projectsRouter = Router();

projectsRouter.get('/', (_req: Request, res: Response) => {
  const result = listProjectsHandler(getWorkspaceStore());
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

projectsRouter.post('/', async (req: Request, res: Response) => {
  const result = await createProjectHandler(
    getWorkspaceStore(),
    req.body as Record<string, unknown>,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(201).json(result.data);
});

projectsRouter.get('/:id', (req: Request, res: Response) => {
  const result = getProjectHandler(getWorkspaceStore(), req.params['id'] as string);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

projectsRouter.patch('/:id', (req: Request, res: Response) => {
  const result = patchProjectHandler(
    getWorkspaceStore(),
    req.params['id'] as string,
    req.body as Record<string, unknown>,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

projectsRouter.post('/:id/close', (req: Request, res: Response) => {
  const result = closeProjectHandler(
    getWorkspaceStore(),
    req.params['id'] as string,
    req.body as Record<string, unknown>,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

projectsRouter.post('/:id/snapshot', async (req: Request, res: Response) => {
  const result = await snapshotProjectHandler(getWorkspaceStore(), req.params['id'] as string);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

projectsRouter.post('/:id/complete-close', async (req: Request, res: Response) => {
  const result = await completeCloseProjectHandler(getWorkspaceStore(), req.params['id'] as string);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});
