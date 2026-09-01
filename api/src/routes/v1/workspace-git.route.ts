import { Router } from 'express';
import type { Request, Response } from 'express';
import { getWorkspaceStore } from '../../services/workspace-store.js';
import {
  getGitStatusHandler,
  listBranchesHandler,
  fetchHandler,
  syncHandler,
  pushHandler,
  checkoutHandler,
  createBranchHandler,
} from './workspace-git.handlers.js';

// mergeParams is required so the parent router's :id (workspaces.route.ts's
// `/:id/git` mount) is visible on req.params here.
export const workspaceGitRouter = Router({ mergeParams: true });

workspaceGitRouter.get('/status', async (req: Request, res: Response) => {
  const result = await getGitStatusHandler(getWorkspaceStore(), req.params['id'] as string);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

workspaceGitRouter.get('/branches', async (req: Request, res: Response) => {
  const result = await listBranchesHandler(getWorkspaceStore(), req.params['id'] as string);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

workspaceGitRouter.post('/fetch', async (req: Request, res: Response) => {
  const result = await fetchHandler(getWorkspaceStore(), req.params['id'] as string);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

workspaceGitRouter.post('/sync', async (req: Request, res: Response) => {
  const result = await syncHandler(getWorkspaceStore(), req.params['id'] as string);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

workspaceGitRouter.post('/push', async (req: Request, res: Response) => {
  const result = await pushHandler(getWorkspaceStore(), req.params['id'] as string);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

workspaceGitRouter.post('/checkout', async (req: Request, res: Response) => {
  const result = await checkoutHandler(
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

workspaceGitRouter.post('/branches', async (req: Request, res: Response) => {
  const result = await createBranchHandler(
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
