import { Router } from 'express';
import type { Request, Response } from 'express';
import { getWorkspaceStore } from '../../services/workspace-store.js';
import type { TaskListFilters, TaskStatus } from '../../services/workspace-store.js';
import { getTaskScheduler } from '../../services/task-scheduler.js';
import {
  listTasksHandler,
  getTaskHandler,
  createTaskHandler,
  patchTaskHandler,
  deleteTaskHandler,
  getQueueHandler,
  enqueueTaskHandler,
} from './tasks.handlers.js';

export const tasksRouter = Router();

// GET /queue must be registered before /:id so it isn't matched as an id param
tasksRouter.get('/queue', (_req: Request, res: Response) => {
  const result = getQueueHandler(getWorkspaceStore(), getTaskScheduler().isPaused());
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

tasksRouter.get('/', (req: Request, res: Response) => {
  const { workspace_id, status } = req.query as { workspace_id?: string; status?: string };
  const filters: TaskListFilters = {};
  if (workspace_id !== undefined) {
    filters.workspaceId = workspace_id === 'null' ? null : workspace_id;
  }
  if (status !== undefined) {
    filters.status = status as TaskStatus;
  }
  const result = listTasksHandler(getWorkspaceStore(), filters);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

tasksRouter.post('/', (req: Request, res: Response) => {
  const result = createTaskHandler(getWorkspaceStore(), req.body as Record<string, unknown>);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(201).json(result.data);
});

tasksRouter.get('/:id', (req: Request, res: Response) => {
  const result = getTaskHandler(getWorkspaceStore(), req.params['id'] as string);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

tasksRouter.patch('/:id', (req: Request, res: Response) => {
  const result = patchTaskHandler(
    getWorkspaceStore(),
    req.params['id'] as string,
    req.body as Record<string, unknown>,
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

tasksRouter.delete('/:id', (req: Request, res: Response) => {
  const result = deleteTaskHandler(getWorkspaceStore(), req.params['id'] as string);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(204).end();
});

tasksRouter.post('/:id/enqueue', (req: Request, res: Response) => {
  const result = enqueueTaskHandler(getWorkspaceStore(), req.params['id'] as string);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  // New work is available — let the (event-driven) scheduler know so it can
  // pick it up immediately rather than waiting on the next unrelated trigger.
  getTaskScheduler().wake();
  res.status(201).json(result.data);
});
