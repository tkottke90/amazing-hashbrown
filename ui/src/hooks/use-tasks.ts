import { signal } from '@preact/signals';
import type { Task, TaskStatus, QueueState, CreateTaskInput, PlanStep } from '@/services/tasks-api';
import {
  fetchTasks,
  fetchQueue,
  createTask as apiCreateTask,
  patchTask as apiPatchTask,
  deleteTask as apiDeleteTask,
  enqueueTask as apiEnqueueTask,
  generatePlan as apiGeneratePlan,
  generatePlanForNewTask as apiGeneratePlanForNewTask,
  type TaskFilters,
} from '@/services/tasks-api';

export const tasks = signal<Task[]>([]);
export const queueState = signal<QueueState>({ queue: [], running: null, paused: false });
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

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const task = await apiCreateTask(input);
  tasks.value = [task, ...tasks.value];
  return task;
}

export async function patchTask(
  id: string,
  patch: Partial<CreateTaskInput & { status: TaskStatus }>,
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

export function groupTasksByStatus(taskList: Task[]): Record<TaskStatus, Task[]> {
  const groups: Record<TaskStatus, Task[]> = {
    pending: [],
    ready: [],
    running: [],
    waiting_on_user: [],
    blocked: [],
    done: [],
    failed: [],
    cancelled: [],
  };
  for (const task of taskList) {
    groups[task.status].push(task);
  }
  return groups;
}
