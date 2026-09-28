import { Router } from 'express';
import type { Request, Response } from 'express';
import { getThreadStore } from '../../services/thread-store.js';
import { getWorkspaceStore } from '../../services/workspace-store.js';
import { getToolSettingsStore } from '../../services/tool-settings-store.js';
import { getCheckpointer } from '../../agents/chat-agent.js';
import { getActiveSseWriter } from '../../agents/active-sse-writer.js';
import { getWakeupStore, toCardPayload, type Wakeup } from '../../services/wakeup-store.js';
import { getWakeupRegistry } from '../../services/wakeup-registry.js';
import { createProvider } from '../../services/provider-factory.js';
import { configManager } from '../../config/env.js';
import { readRawToolsConfig } from './tool-settings.handlers.js';
import {
  listThreadsHandler,
  getThreadHandler,
  type TaskRunSummary,
  renameThreadHandler,
  deleteThreadHandler,
  forkThreadHandler,
  generateTitleHandler,
  getAfterAgentStatusHandler,
  generateThreadReportHandler,
  getThreadToolsHandler,
  putThreadToolsHandler,
  pendingWakeupHandler,
  deleteThreadToolsHandler,
} from './threads.handlers.js';

export const threadsRouter = Router();

threadsRouter.get('/', (_req: Request, res: Response) => {
  res.json(listThreadsHandler(getThreadStore()));
});

// A run thread's header info: which run of which task it records.
function taskRunFor(threadId: string): TaskRunSummary | null {
  const store = getWorkspaceStore();
  const run = store.getTaskRunByThreadId(threadId);
  const task = run ? store.getTask(run.taskId) : null;
  if (!run || !task) return null;
  return {
    taskId: task.id,
    taskTitle: task.title,
    workspaceId: task.workspaceId,
    runId: run.id,
    runNumber: run.runNumber,
    status: run.status,
    triggerSource: run.triggerSource,
  };
}

const isTurnActive = (threadId: string): boolean => getActiveSseWriter(threadId) !== undefined;

threadsRouter.get('/:id', (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const result = getThreadHandler(getThreadStore(), id, { taskRunFor, isTurnActive });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

threadsRouter.get('/:id/after-agent-status', (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const result = getAfterAgentStatusHandler(getThreadStore(), id);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

threadsRouter.get('/:id/report', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const result = await generateThreadReportHandler(getThreadStore(), id);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(result.data.html);
});

threadsRouter.patch('/:id', (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { title } = req.body as { title?: string };
  if (typeof title !== 'string') {
    res.status(400).json({ error: 'title is required' });
    return;
  }
  const result = renameThreadHandler(getThreadStore(), id, title);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

threadsRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const result = await deleteThreadHandler(getThreadStore(), getCheckpointer(), id);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  // The thread's wake-up rows cascaded away; drop any timer still armed.
  getWakeupRegistry().clearThread(id);
  res.status(204).end();
});

// Wake-up card actions (issue #191). The handler validates; the registry
// settles — Trigger now also starts the resumed turn. Both return the
// updated card payload.
function settleWakeupRoute(
  settle: (wakeupId: string) => Wakeup | null,
): (req: Request, res: Response) => void {
  return (req, res) => {
    const { threadId, wakeupId } = req.params as { threadId: string; wakeupId: string };
    const result = pendingWakeupHandler(getWakeupStore(), threadId, wakeupId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    const settled = settle(wakeupId);
    if (!settled) {
      res.status(409).json({ error: 'Wake-up is no longer pending' });
      return;
    }
    res.json(toCardPayload(settled));
  };
}

threadsRouter.post(
  '/:threadId/wakeups/:wakeupId/cancel',
  settleWakeupRoute((wakeupId) => getWakeupRegistry().cancel(wakeupId, 'user_cancel')),
);

threadsRouter.post(
  '/:threadId/wakeups/:wakeupId/trigger',
  settleWakeupRoute((wakeupId) => getWakeupRegistry().triggerNow(wakeupId)),
);

threadsRouter.post('/:id/fork', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { atSeq } = req.body as { atSeq?: number };
  if (typeof atSeq !== 'number') {
    res.status(400).json({ error: 'atSeq is required' });
    return;
  }
  const result = await forkThreadHandler(getThreadStore(), getCheckpointer(), id, atSeq);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

threadsRouter.get('/:id/tools', (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const result = getThreadToolsHandler(
    getThreadStore(),
    getToolSettingsStore(),
    id,
    readRawToolsConfig(configManager.getConfigDir()),
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

threadsRouter.put('/:id/tools', (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const result = putThreadToolsHandler(
    getThreadStore(),
    getToolSettingsStore(),
    id,
    req.body,
    readRawToolsConfig(configManager.getConfigDir()),
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

threadsRouter.delete('/:id/tools', (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const result = deleteThreadToolsHandler(
    getThreadStore(),
    getToolSettingsStore(),
    id,
    readRawToolsConfig(configManager.getConfigDir()),
  );
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

threadsRouter.post('/:id/generate-title', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { provider, model: modelName } = req.body as { provider?: string; model?: string };

  let model;
  try {
    model = createProvider(provider, modelName);
  } catch (err) {
    res.status(500).json({
      error: `No provider available: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const result = await generateTitleHandler(getThreadStore(), model, id, provider, modelName);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});
