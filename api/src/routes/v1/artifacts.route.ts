import { Router } from 'express';
import { getArtifact } from '../../artifacts/artifact-store.js';

export const artifactsRouter = Router();

artifactsRouter.get('/:id', async (req, res) => {
  const artifact = await getArtifact(req.params.id);
  if (!artifact) {
    res.status(404).json({ error: 'Artifact not found' });
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
