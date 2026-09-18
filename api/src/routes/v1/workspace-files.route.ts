import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import { getWorkspaceStore } from '../../services/workspace-store.js';
import {
  getFileTreeHandler,
  getFileContentHandler,
  patchFileContentHandler,
  uploadFilesHandler,
  createDirectoryHandler,
  createFileHandler,
} from './workspace-files.handlers.js';

// mergeParams is required so the parent router's :id (workspaces.route.ts's
// `/:id/files` mount) is visible on req.params here.
export const workspaceFilesRouter = Router({ mergeParams: true });

// memoryStorage (not diskStorage like wiki-upload.route.ts) — the handler
// must validate every filename in the batch (collisions/invalid names)
// before committing any bytes to disk, so a rejected batch never leaves a
// partial write behind.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 20 },
});

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

// These three are literal top-level POST routes — they never collide with
// the GET/PATCH '/*/content' wildcard above (different HTTP methods), even
// if a workspace happens to contain a real file/directory named "upload".

workspaceFilesRouter.post(
  '/upload',
  (req: Request, res: Response, next) => {
    upload.array('files')(req, res, (err: unknown) => {
      if (err) {
        const message = err instanceof multer.MulterError ? err.message : 'Upload failed';
        res.status(413).json({ error: message });
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    const dir = typeof req.query['dir'] === 'string' ? req.query['dir'] : '';
    const files = ((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => ({
      name: f.originalname,
      buffer: f.buffer,
    }));
    const result = await uploadFilesHandler(getWorkspaceStore(), req.params['id'] as string, dir, files);
    if (!result.ok) {
      // uploadFilesHandler's 409 case returns a ConflictFailure (HandlerFailure
      // plus `conflicts`); HandlerResult's public type erases that extra field,
      // so it's read back via an optional-property cast rather than `in`
      // narrowing (which can't add a property no union member declares).
      const conflicts = (result as { conflicts?: string[] }).conflicts;
      res.status(result.status).json({ error: result.error, ...(conflicts ? { conflicts } : {}) });
      return;
    }
    res.status(201).json(result.data);
  },
);

workspaceFilesRouter.post('/directory', async (req: Request, res: Response) => {
  const { dir, name } = req.body as { dir?: string; name?: string };
  if (typeof name !== 'string') {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const result = await createDirectoryHandler(
    getWorkspaceStore(),
    req.params['id'] as string,
    dir ?? '',
    name,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(201).json(result.data);
});

workspaceFilesRouter.post('/file', async (req: Request, res: Response) => {
  const { dir, name } = req.body as { dir?: string; name?: string };
  if (typeof name !== 'string') {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const result = await createFileHandler(
    getWorkspaceStore(),
    req.params['id'] as string,
    dir ?? '',
    name,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(201).json(result.data);
});
