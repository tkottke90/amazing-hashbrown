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

  const { regenerateWebhookToken, ...rest } = patch;
  const triggerConfig = resolveTriggerConfig(current, { ...rest, regenerateWebhookToken });
  const task = store.patchTask(id, { ...rest, triggerConfig });
  if (!task) return notFound(`Task ${id} not found`);

  // R14: a task is enqueued exactly when assigned_to='agent' and status='ready'
  // — there is no separate enqueue action. Idempotent: only fires if no
  // active task_queue row already exists for this task.
  if (task.assignedTo === 'agent' && task.status === 'ready') {
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
