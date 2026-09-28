import { signal } from '@preact/signals';
import type {
  Task,
  TaskStatus,
  QueueState,
  CreateTaskInput,
  PlanStep,
  MoveRequest,
} from '@/services/tasks-api';
import {
  fetchTask,
  fetchTasks,
  moveTask as apiMoveTask,
  fetchQueue,
  createTask as apiCreateTask,
  patchTask as apiPatchTask,
  deleteTask as apiDeleteTask,
  enqueueTask as apiEnqueueTask,
  cancelTask as apiCancelTask,
  pauseTask as apiPauseTask,
  takeOverTask as apiTakeOverTask,
  resumeTask as apiResumeTask,
  generatePlan as apiGeneratePlan,
  generatePlanForNewTask as apiGeneratePlanForNewTask,
  type TaskFilters,
} from '@/services/tasks-api';

export const tasks = signal<Task[]>([]);
export const queueState = signal<QueueState>({ queue: [], running: [] });
export const tasksLoading = signal(false);

export async function refreshTasks(filters: TaskFilters = {}): Promise<void> {
  tasksLoading.value = true;
  try {
    tasks.value = await fetchTasks(filters);
  } catch {
    // best-effort — stays stale until next successful refresh
  } finally {
    tasksLoading.value = false;
  }
}

export async function refreshQueue(): Promise<void> {
  try {
    queueState.value = await fetchQueue();
  } catch {
    // best-effort — widget just stays stale until the next successful refresh
  }
}

// Swaps one task in the list for a newer copy of it — the result of a move,
// a re-fetch, or the original copy restored after a failed optimistic move.
export function replaceTask(task: Task): void {
  tasks.value = tasks.value.map((t) => (t.id === task.id ? task : t));
}

// Re-fetches a single task so its server-computed board (lane, moves,
// reason) catches up with a change pushed over live events.
export async function refreshTask(id: string): Promise<void> {
  try {
    replaceTask(await fetchTask(id));
  } catch {
    // best-effort — the next full refresh catches it up
  }
}

// Moves a task to a Kanban lane and swaps in the server's copy (with its
// new board). Throws the API's RequestError on a rejected move so callers
// can roll back an optimistic update.
export async function moveTask(id: string, move: MoveRequest): Promise<Task> {
  const updated = await apiMoveTask(id, move);
  replaceTask(updated);
  void refreshQueue();
  return updated;
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const task = await apiCreateTask(input);
  tasks.value = [task, ...tasks.value];
  return task;
}

export async function patchTask(
  id: string,
  patch: Partial<CreateTaskInput & { status: TaskStatus; regenerateWebhookToken: boolean }>,
): Promise<Task> {
  const updated = await apiPatchTask(id, patch);
  tasks.value = tasks.value.map((t) => (t.id === id ? updated : t));
  // A status patch may have just enqueued agent work server-side (R14) — the
  // sidebar QueueWidget only polls every 10s, so refresh it here for a
  // snappier update. Harmless no-op refetch when nothing actually enqueued.
  if (patch.status !== undefined) void refreshQueue();
  return updated;
}

export async function deleteTask(id: string): Promise<void> {
  await apiDeleteTask(id);
  tasks.value = tasks.value.filter((t) => t.id !== id);
}

export async function enqueueTask(id: string): Promise<void> {
  await apiEnqueueTask(id);
  await refreshQueue();
}

export async function cancelTask(id: string): Promise<Task> {
  const updated = await apiCancelTask(id);
  tasks.value = tasks.value.map((t) => (t.id === id ? updated : t));
  await refreshQueue();
  return updated;
}

export async function pauseTask(id: string): Promise<Task> {
  const updated = await apiPauseTask(id);
  tasks.value = tasks.value.map((t) => (t.id === id ? updated : t));
  await refreshQueue();
  return updated;
}

export async function takeOverTask(id: string): Promise<Task> {
  const updated = await apiTakeOverTask(id);
  tasks.value = tasks.value.map((t) => (t.id === id ? updated : t));
  await refreshQueue();
  return updated;
}

export async function resumeTask(id: string): Promise<Task> {
  const updated = await apiResumeTask(id);
  tasks.value = tasks.value.map((t) => (t.id === id ? updated : t));
  await refreshQueue();
  return updated;
}

export async function updatePlan(taskId: string, plan: PlanStep[]): Promise<Task> {
  return patchTask(taskId, { plan });
}

export async function generatePlan(taskId: string): Promise<PlanStep[]> {
  return apiGeneratePlan(taskId);
}

export async function generatePlanForNewTask(input: {
  title: string;
  description?: string | null;
  workspaceId?: string | null;
}): Promise<PlanStep[]> {
  return apiGeneratePlanForNewTask(input);
}
