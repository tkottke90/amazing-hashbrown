import { Router } from 'express';
import { getArtifact } from '../../artifacts/artifact-store.js';

export const artifactsRouter = Router();

artifactsRouter.get('/:id', (req, res) => {
  const artifact = getArtifact(req.params.id);
  if (!artifact) {
    res.status(404).json({ error: 'Artifact not found' });
    return;
  }
  res.setHeader('Content-Type', artifact.mimeType);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(artifact.buffer);
});
