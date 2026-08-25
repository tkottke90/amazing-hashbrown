import type { WorkspaceStore, TaskQueueEntry } from '../../services/workspace-store.js';
import type { HandlerFailure, HandlerResult } from './threads.handlers.js';
import { enqueueTaskHandler } from './tasks.handlers.js';

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function notFound(error: string): HandlerFailure {
  return { ok: false, status: 404, error };
}

function conflict(error: string): HandlerFailure {
  return { ok: false, status: 409, error };
}

export function triggerWebhookHandler(
  store: WorkspaceStore,
  token: string,
): HandlerResult<TaskQueueEntry> {
  const task = store.findTaskByWebhookToken(token);
  if (!task) return notFound('No task matches this webhook URL');

  const alreadyActive = store.listQueue().some((entry) => entry.taskId === task.id);
  if (alreadyActive) return conflict(`Task "${task.title}" is already queued or running`);

  const result = enqueueTaskHandler(store, task.id);
  if (!result.ok) return result;
  return ok(result.data);
}
