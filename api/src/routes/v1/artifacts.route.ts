import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { getArtifact } from '../../artifacts/artifact-store.js';
import { uploadArtifactHandler } from './artifacts.handlers.js';

export const artifactsRouter = Router();

// TODO: replace this multipart/form-data upload with a signed-URL flow
// (client requests a signed upload URL, uploads directly to storage, then
// notifies the API) once this needs to scale beyond local/dev use.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// Wraps multer's middleware so failures (e.g. file too large) return the
// same JSON error shape every other route in this API uses, instead of
// falling through to Express's default HTML error page — there's no
// centralized error-handling middleware in app.ts to catch this otherwise.
function handleFileUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof multer.MulterError ? err.message : 'Upload failed';
      res.status(400).json({ error: message });
      return;
    }
    next();
  });
}

artifactsRouter.post('/', handleFileUpload, async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'file is required (multipart field name "file")' });
    return;
  }

  const { threadId, taskId } = req.body as { threadId?: string; taskId?: string };

  const result = await uploadArtifactHandler({
    mimeType: req.file.mimetype,
    original: req.file.buffer,
    threadId,
    taskId,
  });

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(201).json(result.data);
});

artifactsRouter.get('/:id', async (req, res) => {
  const artifact = await getArtifact(req.params.id);
  if (!artifact) {
    res.status(404).json({ error: 'Artifact not found' });
    return;
  }

  // Non-image artifacts have no processed web variant — fall back to
  // serving the original bytes with their real Content-Type.
  if (!artifact.web) {
    res.setHeader('Content-Type', artifact.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(artifact.original);
    return;
  }

  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(artifact.web);
});

artifactsRouter.get('/:id/preview', async (req, res) => {
  const artifact = await getArtifact(req.params.id);
  if (!artifact) {
    res.status(404).json({ error: 'Artifact not found' });
    return;
  }
  if (!artifact.preview) {
    res.status(404).json({ error: 'No preview available for this artifact' });
    return;
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(artifact.preview);
});

artifactsRouter.get('/:id/original', async (req, res) => {
  const artifact = await getArtifact(req.params.id);
  if (!artifact) {
    res.status(404).json({ error: 'Artifact not found' });
    return;
  }
  res.setHeader('Content-Type', artifact.mimeType);
  res.setHeader('Content-Disposition', 'attachment');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(artifact.original);
});
