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
// req.params[0], NOT the Express-5-only named `*path` notation. `/*/content`
// captures the full nested relative path before the literal "/content"
// suffix (path-to-regexp@0.1.x's `*` is a greedy, slash-crossing capture).
workspaceFilesRouter.get('/*/content', async (req: Request, res: Response) => {
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
  if (result.data.kind === 'text') {
    res.type('text/plain').send(result.data.content);
  } else {
    res.setHeader('Content-Type', result.data.contentType);
    res.send(result.data.buffer);
  }
});

workspaceFilesRouter.patch('/*/content', async (req: Request, res: Response) => {
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
