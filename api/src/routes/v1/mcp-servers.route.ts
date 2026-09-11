import { Router } from 'express';
import type { Request, Response } from 'express';
import { toolsManager } from '../../services/tools-manager.js';
import {
  listMcpServersHandler,
  createMcpServerHandler,
  patchMcpServerHandler,
  deleteMcpServerHandler,
  testNewMcpServerHandler,
  testExistingMcpServerHandler,
} from './mcp-servers.handlers.js';

export const mcpServersRouter = Router();

mcpServersRouter.get('/', (_req: Request, res: Response) => {
  const result = listMcpServersHandler(toolsManager);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

mcpServersRouter.post('/', async (req: Request, res: Response) => {
  const result = await createMcpServerHandler(toolsManager, req.body);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(201).json(result.data);
});

// Test-connection endpoints mirror providers.route.ts's embeddings/models
// test convention: the JSON body itself carries `ok`, not just the HTTP
// status — a failed connection is a normal 502 { ok: false, error }, not
// just a bare { error } like the CRUD routes above.
mcpServersRouter.post('/test', async (req: Request, res: Response) => {
  const result = await testNewMcpServerHandler(req.body);
  if (!result.ok) {
    res.status(result.status).json({ ok: false, error: result.error });
    return;
  }
  res.json({ ok: true, ...result.data });
});

mcpServersRouter.patch('/:name', async (req: Request, res: Response) => {
  const result = await patchMcpServerHandler(toolsManager, req.params['name'] as string, req.body);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

mcpServersRouter.delete('/:name', async (req: Request, res: Response) => {
  const result = await deleteMcpServerHandler(toolsManager, req.params['name'] as string);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(204).end();
});

mcpServersRouter.post('/:name/test', async (req: Request, res: Response) => {
  const result = await testExistingMcpServerHandler(
    toolsManager,
    req.params['name'] as string,
    req.body,
  );
  if (!result.ok) {
    res.status(result.status).json({ ok: false, error: result.error });
    return;
  }
  res.json({ ok: true, ...result.data });
});
