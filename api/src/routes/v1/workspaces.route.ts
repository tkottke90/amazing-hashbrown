import { Router } from 'express';
import type { Request, Response } from 'express';
import { getWorkspaceStore } from '../../services/workspace-store.js';
import {
  listWorkspacesHandler,
  getWorkspaceHandler,
  createWorkspaceHandler,
  patchWorkspaceHandler,
  deleteWorkspaceHandler,
  cleanupDependenciesHandler,
} from './workspaces.handlers.js';
import { workspaceFilesRouter } from './workspace-files.route.js';
import { workspaceGitRouter } from './workspace-git.route.js';
import { workspaceChatRouter } from './workspace-chat.route.js';

export const workspacesRouter = Router();

workspacesRouter.get('/', (_req: Request, res: Response) => {
  const result = listWorkspacesHandler(getWorkspaceStore());
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

workspacesRouter.post('/', async (req: Request, res: Response) => {
  const result = await createWorkspaceHandler(
    getWorkspaceStore(),
    req.body as Record<string, unknown>,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(201).json(result.data);
});

workspacesRouter.get('/:id', (req: Request, res: Response) => {
  const result = getWorkspaceHandler(getWorkspaceStore(), req.params['id'] as string);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

workspacesRouter.patch('/:id', (req: Request, res: Response) => {
  const result = patchWorkspaceHandler(
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

workspacesRouter.delete('/:id', async (req: Request, res: Response) => {
  const result = await deleteWorkspaceHandler(getWorkspaceStore(), req.params['id'] as string);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(204).end();
});

workspacesRouter.post('/:id/cleanup-dependencies', async (req: Request, res: Response) => {
  const result = await cleanupDependenciesHandler(
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

workspacesRouter.use('/:id/files', workspaceFilesRouter);
workspacesRouter.use('/:id/git', workspaceGitRouter);
workspacesRouter.use('/:id/chat', workspaceChatRouter);
