import { Router } from 'express';
import type { Request, Response } from 'express';
import { getTrackerRegistry } from '../../services/tracker-registry.js';
import {
  listTrackersHandler,
  resolveTrackerUrlHandler,
  getTrackerItemHandler,
  createTrackerItemHandler,
  verifyGithubTokenHandler,
} from './trackers.handlers.js';

export const trackersRouter = Router();

// Static paths must be registered before the /:type param routes so Express
// doesn't match "github" as a :type value here — see tasks.route.ts for the
// same convention with /queue.
trackersRouter.post('/github/verify', async (req: Request, res: Response) => {
  const result = await verifyGithubTokenHandler(req.body as Record<string, unknown>);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

trackersRouter.get('/', (_req: Request, res: Response) => {
  const result = listTrackersHandler(getTrackerRegistry());
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

trackersRouter.post('/:type/resolve', async (req: Request, res: Response) => {
  const result = await resolveTrackerUrlHandler(
    getTrackerRegistry(),
    req.params['type'] as string,
    req.body as Record<string, unknown>,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

// A tracker item id (e.g. GitHub's "owner/repo#123") can contain slashes and
// "#", so it's passed as a query param rather than a path segment.
trackersRouter.get('/:type/items', async (req: Request, res: Response) => {
  const result = await getTrackerItemHandler(
    getTrackerRegistry(),
    req.params['type'] as string,
    req.query['id'] as string,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

trackersRouter.post('/:type/items', async (req: Request, res: Response) => {
  const result = await createTrackerItemHandler(
    getTrackerRegistry(),
    req.params['type'] as string,
    req.body as Record<string, unknown>,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(201).json(result.data);
});
