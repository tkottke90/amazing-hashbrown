import { Router } from 'express';
import type { Request, Response } from 'express';
import { getWorkspaceStore } from '../../services/workspace-store.js';
import { getThreadStore } from '../../services/thread-store.js';
import { generateWorkspaceRetrospectiveHandler } from './workspace-retrospective.handlers.js';

// Mounted at workspacesRouter.use('/:id/retrospective-report', workspaceRetrospectiveRouter) —
// :id is defined on the parent router, so this one needs mergeParams to see it.
export const workspaceRetrospectiveRouter = Router({ mergeParams: true });

workspaceRetrospectiveRouter.get('/', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { provider, model, narrative } = req.query as {
    provider?: string;
    model?: string;
    narrative?: string;
  };

  const result = await generateWorkspaceRetrospectiveHandler(
    { workspaceStore: getWorkspaceStore(), threadStore: getThreadStore() },
    id,
    { provider, model, narrative: narrative === 'false' ? false : undefined },
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(result.data.html);
});
