import { Router } from 'express';
import type { Request, Response } from 'express';
import { getThreadStore, type ThreadType } from '../../services/thread-store.js';
import { getWorkspaceStore } from '../../services/workspace-store.js';
import { getToolSettingsStore } from '../../services/tool-settings-store.js';
import { getCheckpointer } from '../../agents/chat-agent.js';
import { getActiveSseWriter } from '../../agents/active-sse-writer.js';
import { getWakeupStore, toCardPayload, type Wakeup } from '../../services/wakeup-store.js';
import { getWakeupRegistry } from '../../services/wakeup-registry.js';
import { createProvider } from '../../services/provider-factory.js';
import { configManager, env } from '../../config/env.js';
import { readRawToolsConfig } from './tool-settings.handlers.js';
import {
  listThreadsHandler,
  getThreadHandler,
  type TaskRunSummary,
  renameThreadHandler,
  archiveThreadHandler,
  unarchiveThreadHandler,
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

const THREAD_TYPES: readonly ThreadType[] = ['chat', 'wiki', 'workspace-chat', 'task'];

function isThreadType(value: string): value is ThreadType {
  return (THREAD_TYPES as readonly string[]).includes(value);
}

// No `type` param keeps the long-standing default (the main chat sidebar's
// list) unchanged; `?type=all` is the only way to get every thread type —
// a query param instead of a sibling path (e.g. `/all`) avoids needing to
// register it ahead of `/:id` to stop Express matching it as `id: 'all'`.
//
// Retention/archive filtering (the Sidebar Retention Window + Archived
// Thread exclusion) applies ONLY to the no-`type`-param branch below — the
// sidebar's own fetch. `?type=all` and any explicit `?type=X` stay fully
// unfiltered, so the Threads page is always a complete, trustworthy record
// of everything that still exists. See ADR-0027 for why this is deliberate,
// not an oversight to "fix" into uniform filtering.
threadsRouter.get('/', (req: Request, res: Response) => {
  const { type } = req.query as { type?: string };
  if (type === undefined) {
    const retentionDays = env.chat.sidebarRetentionDays;
    const updatedAfter =
      retentionDays > 0
        ? new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()
        : undefined;
    res.json(
      listThreadsHandler(getThreadStore(), { type: 'chat', excludeArchived: true, updatedAfter }),
    );
  } else if (type === 'all') {
    res.json(listThreadsHandler(getThreadStore()));
  } else if (isThreadType(type)) {
    res.json(listThreadsHandler(getThreadStore(), { type }));
  } else {
    res.status(400).json({ error: `Unknown thread type "${type}"` });
  }
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

// Archiving is scoped to 'chat' threads only (design doc D1) — a 400 here,
// not a silent no-op, so a caller attempting it on a 'wiki'/'workspace-chat'/
// 'task' thread gets an explicit, unambiguous rejection instead of wondering
// why nothing happened.
threadsRouter.post('/:id/archive', (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const meta = getThreadStore().getThreadMeta(id);
  if (meta && meta.type !== 'chat') {
    res.status(400).json({ error: 'Only chat threads can be archived' });
    return;
  }
  const result = archiveThreadHandler(getThreadStore(), id);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.data);
});

threadsRouter.post('/:id/unarchive', (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const result = unarchiveThreadHandler(getThreadStore(), id);
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
