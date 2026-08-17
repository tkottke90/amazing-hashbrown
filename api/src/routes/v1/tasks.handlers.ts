import type {
  WorkspaceStore,
  NewTaskInput,
  PatchTaskInput,
  TaskListFilters,
} from '../../services/workspace-store.js';
import type { HandlerFailure, HandlerResult } from './threads.handlers.js';

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function notFound(error: string): HandlerFailure {
  return { ok: false, status: 404, error };
}

function badRequest(error: string): HandlerFailure {
  return { ok: false, status: 400, error };
}

export function listTasksHandler(store: WorkspaceStore, filters: TaskListFilters = {}) {
  return ok(store.listTasks(filters));
}

export function getTaskHandler(store: WorkspaceStore, id: string) {
  const task = store.getTask(id);
  if (!task) return notFound(`Task ${id} not found`);
  return ok(task);
}

export function createTaskHandler(
  store: WorkspaceStore,
  body: Partial<NewTaskInput>,
): HandlerResult<ReturnType<WorkspaceStore['getTask']>> {
  if (!body.title || typeof body.title !== 'string') return badRequest('title is required');
  const task = store.createTask(body as NewTaskInput);
  return ok(task);
}

export function patchTaskHandler(
  store: WorkspaceStore,
  id: string,
  patch: PatchTaskInput,
): HandlerResult<ReturnType<WorkspaceStore['getTask']>> {
  const task = store.patchTask(id, patch);
  if (!task) return notFound(`Task ${id} not found`);
  return ok(task);
}

export function deleteTaskHandler(
  store: WorkspaceStore,
  id: string,
): HandlerResult<{ deleted: true }> {
  const deleted = store.deleteTask(id);
  if (!deleted) return notFound(`Task ${id} not found`);
  return ok({ deleted: true });
}

export function getQueueHandler(store: WorkspaceStore) {
  const queue = store.listQueue();
  const running = store.getRunningEntry();
  const queueWithTasks = queue.map((entry) => ({
    ...entry,
    task: store.getTask(entry.taskId) ?? null,
  }));
  return ok({ queue: queueWithTasks, running: running ?? null });
}

export function enqueueTaskHandler(
  store: WorkspaceStore,
  taskId: string,
): HandlerResult<ReturnType<WorkspaceStore['enqueueTask']>> {
  const task = store.getTask(taskId);
  if (!task) return notFound(`Task ${taskId} not found`);
  const entry = store.enqueueTask(taskId);
  return ok(entry);
}
