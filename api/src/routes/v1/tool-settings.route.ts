import { Router } from 'express';
import type { Request, Response } from 'express';
import { toolsManager } from '../../services/tools-manager.js';
import { configManager } from '../../config/env.js';
import {
  listToolSettingsHandler,
  patchToolSettingHandler,
  deleteToolSettingHandler,
  refreshToolSettingsHandler,
} from './tool-settings.handlers.js';

export const toolSettingsRouter = Router();

toolSettingsRouter.get('/', (_req: Request, res: Response) => {
  const result = listToolSettingsHandler();
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

toolSettingsRouter.patch('/:toolId', (req: Request, res: Response) => {
  const result = patchToolSettingHandler(
    req.params['toolId'] as string,
    req.body,
    configManager.getConfigDir(),
    () => configManager.reload(),
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

toolSettingsRouter.delete('/:toolId', (req: Request, res: Response) => {
  const result = deleteToolSettingHandler(
    req.params['toolId'] as string,
    configManager.getConfigDir(),
    () => configManager.reload(),
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

// Explicit user action only (the Settings > Tools "Refresh" button) — never
// triggered automatically by GET / just from loading the page, matching the
// existing MCP servers panel's "no side effects from viewing a page" rule.
toolSettingsRouter.post('/refresh', async (_req: Request, res: Response) => {
  const result = await refreshToolSettingsHandler(toolsManager);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});
