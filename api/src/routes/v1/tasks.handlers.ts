import { randomUUID } from 'node:crypto';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type {
  WorkspaceStore,
  NewTaskInput,
  PatchTaskInput,
  PlanStep,
  TaskListFilters,
  TriggerType,
} from '../../services/workspace-store.js';
import type { HandlerFailure, HandlerResult } from './threads.handlers.js';
import { getWikiRegistry } from '../../services/wiki.js';
import { getFileTree } from '../../services/workspace-files.js';
// Routes reaching into the agents layer — the only such direction in this
// file — because the abort registry (a per-process runtime map, not a DB
// table) is the only place that knows whether a task_queue entry currently
// has a live, abortable agent run. See active-task-abort.ts.
import { getTaskAbort, setAbortIntent } from '../../agents/active-task-abort.js';
import {
  buildFileListingBlock,
  buildPathAPrompt,
  buildPathBHumanMessage,
  buildWikiContextBlock,
  parsePlanSteps,
  runPathA,
  runPathB,
} from '../../agents/plan-generation.js';

function ok<T>(data: T): HandlerResult<T> {
  return { ok: true, data };
}

function notFound(error: string): HandlerFailure {
  return { ok: false, status: 404, error };
}

function badRequest(error: string): HandlerFailure {
  return { ok: false, status: 400, error };
}

function serverError(error: string): HandlerFailure {
  return { ok: false, status: 500, error };
}

function conflict(error: string): HandlerFailure {
  return { ok: false, status: 409, error };
}

// The server is the sole source of truth for a webhook task's token — a
// client can never set trigger_config.webhookToken directly, even via a
// generic patch. A token is (re)generated whenever the resulting trigger
// type is 'webhook' and either none exists yet or regeneration was asked for.
function resolveTriggerConfig(
  current: { triggerType: TriggerType; triggerConfig: unknown } | null,
  incoming: {
    triggerType?: TriggerType;
    triggerConfig?: unknown;
    regenerateWebhookToken?: boolean;
  },
): unknown {
  const resultingType = incoming.triggerType ?? current?.triggerType ?? 'manual';
  if (resultingType !== 'webhook') return incoming.triggerConfig;

  const existingToken = (current?.triggerConfig as { webhookToken?: string } | null)?.webhookToken;
  const webhookToken =
    incoming.regenerateWebhookToken || !existingToken ? randomUUID() : existingToken;
  return { webhookToken };
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
  const triggerConfig = resolveTriggerConfig(null, body);
  const task = store.createTask({ ...body, triggerConfig } as NewTaskInput);
  return ok(task);
}

export function patchTaskHandler(
  store: WorkspaceStore,
  id: string,
  patch: PatchTaskInput & { regenerateWebhookToken?: boolean },
): HandlerResult<ReturnType<WorkspaceStore['getTask']>> {
  const current = store.getTask(id);
  if (!current) return notFound(`Task ${id} not found`);

  // Reject reassigning a queued/running task away from the agent through
  // the generic PATCH — that's what take-over is for, and it needs to
  // dequeue/abort the live run in the same step, which a plain field patch
  // can't do. Diffs against what's actually *changing*: the UI's Save
  // button always resends the task's current, unchanged assignedTo/status
  // on every save, so a presence-only check would break ordinary saves.
  if (
    patch.assignedTo !== undefined &&
    patch.assignedTo !== current.assignedTo &&
    current.assignedTo === 'agent' &&
    (current.status === 'ready' || current.status === 'running')
  ) {
    return badRequest(
      `Cannot reassign a ${current.status} task away from the agent — use take-over instead.`,
    );
  }

  const { regenerateWebhookToken, ...rest } = patch;
  const triggerConfig = resolveTriggerConfig(current, { ...rest, regenerateWebhookToken });
  const task = store.patchTask(id, { ...rest, triggerConfig });
  if (!task) return notFound(`Task ${id} not found`);

  // A blocked -> ready transition is a Resume: reuse the task's existing
  // paused task_queue row (resumePausedEntry) instead of falling into the
  // R14 branch below, which would enqueueTask() a *new* row. (The existing
  // alreadyQueued dedup check would prevent an actual duplicate row even
  // without this branch — the real bug this avoids is that nothing else
  // ever un-pauses a paused row, so without this the task would stay
  // wedged at task_queue.status='paused' forever.)
  if (current.status === 'blocked' && task.status === 'ready') {
    const pausedEntry = store.listQueue().find((e) => e.taskId === id && e.status === 'paused');
    if (pausedEntry) {
      store.resumePausedEntry(pausedEntry.id);
    } else if (task.assignedTo === 'agent') {
      // Defensive fallback — data got out of sync (no paused row exists);
      // enqueue fresh rather than leaving the task stuck.
      store.enqueueTask(id);
    }
  } else if (task.assignedTo === 'agent' && task.status === 'ready') {
    // R14: a task is enqueued exactly when assigned_to='agent' and
    // status='ready' — there is no separate enqueue action. Idempotent:
    // only fires if no active task_queue row already exists for this task.
    const alreadyQueued = store.listQueue().some((entry) => entry.taskId === id);
    if (!alreadyQueued) store.enqueueTask(id);
  }

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

export function getQueueHandler(store: WorkspaceStore, paused: boolean) {
  const queue = store.listQueue();
  const running = store.getRunningEntry();
  const queueWithTasks = queue.map((entry) => ({
    ...entry,
    task: store.getTask(entry.taskId) ?? null,
  }));
  return ok({ queue: queueWithTasks, running: running ?? null, paused });
}

export function enqueueTaskHandler(
  store: WorkspaceStore,
  taskId: string,
): HandlerResult<ReturnType<WorkspaceStore['enqueueTask']>> {
  const task = store.getTask(taskId);
  if (!task) return notFound(`Task ${taskId} not found`);
  const entry = store.enqueueTask(taskId);
  // Keep tasks.status in sync with the fact that this task is now queued —
  // mirrors the same invariant patchTaskHandler enforces for the R14 path.
  if (task.status !== 'ready') {
    store.patchTask(taskId, { status: 'ready' });
  }
  return ok(entry);
}

export function cancelTaskHandler(
  store: WorkspaceStore,
  taskId: string,
): HandlerResult<ReturnType<WorkspaceStore['getTask']>> {
  const task = store.getTask(taskId);
  if (!task) return notFound(`Task ${taskId} not found`);
  if (task.status !== 'ready' && task.status !== 'running') {
    return conflict(`Task is ${task.status}, cannot cancel`);
  }

  if (task.status === 'running') {
    const running = store.getRunningEntry();
    if (!running || running.taskId !== taskId) {
      return conflict('Task is not currently running');
    }
    const abortEntry = getTaskAbort(running.id);
    if (!abortEntry) {
      return conflict('Task run is not currently abortable');
    }
    setAbortIntent(running.id, 'cancel');
    abortEntry.controller.abort();
    // Task stays 'running' in the response — the transition to 'cancelled'
    // lands asynchronously in executeTask's catch, surfaced via the
    // task_queue_update SSE broadcast.
    return ok(task);
  }

  // ready: nothing executing yet, act synchronously.
  const pending = store.listQueue().find((e) => e.taskId === taskId && e.status === 'pending');
  if (pending) {
    store.completeQueueEntry(pending.id, 'cancelled');
  } else {
    // Defensive fallback — a ready task should always have a matching
    // pending queue row per R14, but don't leave the task un-cancellable
    // if that invariant is somehow violated.
    store.patchTask(taskId, { status: 'cancelled' });
  }
  return ok(store.getTask(taskId));
}

export function pauseTaskHandler(
  store: WorkspaceStore,
  taskId: string,
): HandlerResult<ReturnType<WorkspaceStore['getTask']>> {
  const task = store.getTask(taskId);
  if (!task) return notFound(`Task ${taskId} not found`);
  if (task.status !== 'running') {
    return conflict(`Task is ${task.status}, cannot pause`);
  }
  const running = store.getRunningEntry();
  if (!running || running.taskId !== taskId) {
    return conflict('Task is not currently running');
  }
  const abortEntry = getTaskAbort(running.id);
  if (!abortEntry) {
    return conflict('Task run is not currently abortable');
  }
  setAbortIntent(running.id, 'pause');
  abortEntry.controller.abort();
  return ok(task); // unchanged; 'blocked' transition lands asynchronously
}

export function takeOverTaskHandler(
  store: WorkspaceStore,
  taskId: string,
): HandlerResult<ReturnType<WorkspaceStore['getTask']>> {
  const task = store.getTask(taskId);
  if (!task) return notFound(`Task ${taskId} not found`);
  if (task.status !== 'ready' && task.status !== 'running') {
    return conflict(`Task is ${task.status}, cannot take over`);
  }

  // Commit the reassignment FIRST, synchronously — this is what guarantees
  // executeTask's async catch can never clobber it, no matter how the
  // abort resolves.
  const updated = store.patchTask(taskId, { status: 'pending', assignedTo: 'user' })!;

  if (task.status === 'running') {
    const running = store.getRunningEntry();
    if (running && running.taskId === taskId) {
      const abortEntry = getTaskAbort(running.id);
      if (abortEntry) {
        setAbortIntent(running.id, 'take-over');
        abortEntry.controller.abort();
      } else {
        // No live controller — nothing will ever call detachQueueEntry for
        // this row, so do it directly rather than leaving an orphaned
        // 'running' row.
        store.detachQueueEntry(running.id);
      }
    }
  } else {
    const pending = store.listQueue().find((e) => e.taskId === taskId && e.status === 'pending');
    if (pending) store.detachQueueEntry(pending.id);
  }

  return ok(updated);
}

// ---------------------------------------------------------------------------
// AI plan generation
// ---------------------------------------------------------------------------
//
// Shared by both generate-plan handlers below. Never persists — callers
// (the frontend, via the existing PATCH /:id / updatePlan) are responsible
// for appending the returned steps to a task's plan.

async function generatePlanCore(
  store: WorkspaceStore,
  model: BaseChatModel,
  provider: string | undefined,
  modelName: string | undefined,
  input: { title: string; description: string | null; workspaceId: string | null },
): Promise<HandlerResult<PlanStep[]>> {
  let raw: string;
  try {
    if (input.workspaceId) {
      const workspace = store.getWorkspace(input.workspaceId);
      if (!workspace) {
        // A stale/unresolvable workspace_id degrades to "no workspace
        // context" rather than a failure — generation still proceeds.
        const prompt = buildPathAPrompt({
          title: input.title,
          description: input.description,
          workspace: null,
          wikiBlock: null,
          fileBlock: null,
        });
        raw = await runPathA(model, prompt, provider, modelName);
      } else {
        const query = `${input.title} ${input.description ?? ''}`.trim();

        let wikiBlock: string | null = null;
        if (workspace.wikiId) {
          try {
            const registry = await getWikiRegistry();
            const wiki = await registry.load(workspace.wikiId);
            wikiBlock = await buildWikiContextBlock(wiki, query);
          } catch {
            wikiBlock = null;
          }
        }

        let fileBlock: string | null = null;
        try {
          const { entries } = await getFileTree(workspace.id, {
            location: workspace.location,
            git: workspace.git,
          });
          fileBlock = buildFileListingBlock(entries);
        } catch {
          fileBlock = null;
        }

        const prompt = buildPathAPrompt({
          title: input.title,
          description: input.description,
          workspace,
          wikiBlock,
          fileBlock,
        });
        raw = await runPathA(model, prompt, provider, modelName);
      }
    } else {
      const humanMessage = buildPathBHumanMessage(input.title, input.description);
      raw = await runPathB(model, humanMessage, provider, modelName);
    }
  } catch (err) {
    return serverError(
      `Plan generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const steps = parsePlanSteps(raw);
  if (!steps) return serverError('Plan generation produced an unparseable response');
  return ok(steps);
}

export async function generatePlanForNewTaskHandler(
  store: WorkspaceStore,
  model: BaseChatModel,
  provider: string | undefined,
  modelName: string | undefined,
  body: { title?: unknown; description?: unknown; workspaceId?: unknown },
): Promise<HandlerResult<PlanStep[]>> {
  if (!body.title || typeof body.title !== 'string' || !body.title.trim()) {
    return badRequest('title is required');
  }
  const description = typeof body.description === 'string' ? body.description : null;
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : null;

  return generatePlanCore(store, model, provider, modelName, {
    title: body.title,
    description,
    workspaceId,
  });
}

export async function generatePlanForTaskHandler(
  store: WorkspaceStore,
  model: BaseChatModel,
  provider: string | undefined,
  modelName: string | undefined,
  id: string,
): Promise<HandlerResult<PlanStep[]>> {
  const task = store.getTask(id);
  if (!task) return notFound(`Task ${id} not found`);

  return generatePlanCore(store, model, provider, modelName, {
    title: task.title,
    description: task.description,
    workspaceId: task.workspaceId,
  });
}
