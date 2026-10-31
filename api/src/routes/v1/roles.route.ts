import { Router } from 'express';
import type { Request, Response } from 'express';
import { configManager } from '../../config/env.js';
import {
  listRolesHandler,
  createRoleHandler,
  patchRoleHandler,
  deleteRoleHandler,
  setDefaultRoleHandler,
  type HandlerFailure,
} from './roles.handlers.js';

export const rolesRouter = Router();

function sendFailure(res: Response, result: HandlerFailure): void {
  res.status(result.status).json({
    error: result.error,
    ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
  });
}

rolesRouter.get('/', (_req: Request, res: Response) => {
  const result = listRolesHandler(configManager.getConfigDir());
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json(result.data);
});

rolesRouter.post('/', (req: Request, res: Response) => {
  const result = createRoleHandler(req.body, configManager.getConfigDir(), () =>
    configManager.reload(),
  );
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.status(201).json(result.data);
});

// Registered before /:name so Express doesn't route "default-role" through
// the name param path — same reason tool-settings.route.ts registers
// /shell_exec/env-vars before /:toolId.
rolesRouter.patch('/default-role', (req: Request, res: Response) => {
  const result = setDefaultRoleHandler(req.body, configManager.getConfigDir(), () =>
    configManager.reload(),
  );
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json(result.data);
});

rolesRouter.patch('/:name', (req: Request, res: Response) => {
  const result = patchRoleHandler(
    req.params['name'] as string,
    req.body,
    configManager.getConfigDir(),
    () => configManager.reload(),
  );
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json(result.data);
});

// 200 with a body (not 204) — the shared frontend request<T>() helper always
// calls res.json() on success, which throws on an empty 204 body.
rolesRouter.delete('/:name', (req: Request, res: Response) => {
  const result = deleteRoleHandler(req.params['name'] as string, configManager.getConfigDir(), () =>
    configManager.reload(),
  );
  if (!result.ok) {
    sendFailure(res, result);
    return;
  }
  res.json(result.data);
});
