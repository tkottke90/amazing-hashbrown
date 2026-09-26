import { Router } from 'express';
import type { Request, Response } from 'express';
import { getWorkspaceStore } from '../../services/workspace-store.js';
import { searchWorkspaceSkillsHandler } from './workspace-skills.handlers.js';

// mergeParams is required so the parent router's :id (workspaces.route.ts's
// `/:id/skills` mount) is visible on req.params here.
export const workspaceSkillsRouter = Router({ mergeParams: true });

workspaceSkillsRouter.get('/', async (req: Request, res: Response) => {
  const q = (req.query['q'] as string | undefined)?.trim();
  const result = await searchWorkspaceSkillsHandler(
    getWorkspaceStore(),
    req.params['id'] as string,
    q,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});
