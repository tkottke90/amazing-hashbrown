import type { NewTaskInput, WorkspaceStore } from '../../services/workspace-store.js';
import type { ThreadStore } from '../../services/thread-store.js';
import type { HandlerFailure, HandlerResult } from './threads.handlers.js';
import { withBoard, type BoardTaskResponse } from './tasks-board.handlers.js';

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function badRequest(error: string): HandlerFailure {
  return { ok: false, status: 400, error };
}

// Creates a task via the webhook, per
// docs/superpowers/specs/2026-10-02-webhook-task-creation-design.md's
// "Status/assignedTo/workspace resolution" — the core hardening logic of
// this whole feature. A task only ever auto-runs when the caller was
// explicit about all three of: a valid workspace, assignedTo: 'agent', and
// status: 'ready'. Any other combination — including a 'ready' request
// with no explicit 'agent' assignment — is a silent no-op: the task is
// simply created and left exactly as createTask() made it.
export function createWebhookTaskHandler(
  store: WorkspaceStore,
  threadStore: ThreadStore | null,
  body: Record<string, unknown>,
  workspaceIdHeader: string | undefined,
): HandlerResult<BoardTaskResponse> {
  if (!body['title'] || typeof body['title'] !== 'string') return badRequest('title is required');

  let workspaceId: string | null = null;
  if (workspaceIdHeader !== undefined) {
    const workspace = store.getWorkspace(workspaceIdHeader);
    if (!workspace) return badRequest(`Unknown workspace "${workspaceIdHeader}"`);
    workspaceId = workspace.id;
  }

  const requestedStatus = body['status'];
  if (
    requestedStatus !== undefined &&
    requestedStatus !== 'pending' &&
    requestedStatus !== 'ready'
  ) {
    return badRequest("status must be 'pending' or 'ready'");
  }

  const requestedAssignedTo = body['assignedTo'] ?? 'user';
  if (requestedAssignedTo !== 'user' && requestedAssignedTo !== 'agent') {
    return badRequest("assignedTo must be 'user' or 'agent'");
  }

  const task = store.createTask({
    ...(body as Partial<NewTaskInput>),
    workspaceId,
    assignedTo: requestedAssignedTo,
    triggerSource: 'webhook',
  } as NewTaskInput);

  const shouldActivate =
    workspaceId !== null && requestedAssignedTo === 'agent' && requestedStatus === 'ready';

  let finalTask = task;
  if (shouldActivate) {
    finalTask = store.patchTask(task.id, { status: 'ready' })!;
    store.enqueueTask(task.id, { triggerSource: 'webhook' });
  }

  return ok(withBoard(store, threadStore, finalTask));
}
