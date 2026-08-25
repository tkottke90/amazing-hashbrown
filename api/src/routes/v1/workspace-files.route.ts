import { Router } from 'express';
import type { Request, Response } from 'express';
import { getWorkspaceStore } from '../../services/workspace-store.js';
import {
  getFileTreeHandler,
  getFileContentHandler,
  patchFileContentHandler,
} from './workspace-files.handlers.js';

// mergeParams is required so the parent router's :id (workspaces.route.ts's
// `/:id/files` mount) is visible on req.params here.
export const workspaceFilesRouter = Router({ mergeParams: true });

workspaceFilesRouter.get('/', async (req: Request, res: Response) => {
  const result = await getFileTreeHandler(getWorkspaceStore(), req.params['id'] as string);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

// Express is pinned to 4.19.0 (not 5) — a bare `*` wildcard, captured as
// req.params[0], NOT the Express-5-only named `*path` notation.
workspaceFilesRouter.get('/*', async (req: Request, res: Response) => {
  const relativePath = req.params[0] as string;
  const result = await getFileContentHandler(
    getWorkspaceStore(),
    req.params['id'] as string,
    relativePath,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.type('text/plain').send(result.data);
});

workspaceFilesRouter.patch('/*', async (req: Request, res: Response) => {
  const relativePath = req.params[0] as string;
  const result = await patchFileContentHandler(
    getWorkspaceStore(),
    req.params['id'] as string,
    relativePath,
    req.body as Record<string, unknown>,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});
