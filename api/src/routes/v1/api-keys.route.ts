import { Router } from 'express';
import type { Request, Response } from 'express';
import { getApiKeyStore } from '../../services/api-key-store.js';
import {
  createApiKeyHandler,
  listApiKeysHandler,
  rotateApiKeyHandler,
  revokeApiKeyHandler,
} from './api-keys.handlers.js';

export const apiKeysRouter = Router();

apiKeysRouter.post('/', (req: Request, res: Response) => {
  const result = createApiKeyHandler(getApiKeyStore(), req.body as Record<string, unknown>);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(201).json(result.data);
});

apiKeysRouter.get('/', (_req: Request, res: Response) => {
  res.json(listApiKeysHandler(getApiKeyStore()));
});

apiKeysRouter.post('/:id/rotate', (req: Request, res: Response) => {
  const result = rotateApiKeyHandler(getApiKeyStore(), req.params['id'] as string);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(200).json(result.data);
});

apiKeysRouter.delete('/:id', (req: Request, res: Response) => {
  const result = revokeApiKeyHandler(getApiKeyStore(), req.params['id'] as string);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(204).end();
});
