import { signal } from '@preact/signals';
import type { Task, TaskStatus, QueueState, CreateTaskInput, PlanStep } from '@/services/tasks-api';
import {
  fetchTasks,
  fetchQueue,
  createTask as apiCreateTask,
  patchTask as apiPatchTask,
  deleteTask as apiDeleteTask,
  enqueueTask as apiEnqueueTask,
  type TaskFilters,
} from '@/services/tasks-api';

export const tasks = signal<Task[]>([]);
export const queueState = signal<QueueState>({ queue: [], running: null });
export const tasksLoading = signal(false);

export async function refreshTasks(filters: TaskFilters = {}): Promise<void> {
  tasksLoading.value = true;
  try {
    tasks.value = await fetchTasks(filters);
  } finally {
    tasksLoading.value = false;
  }
}

export async function refreshQueue(): Promise<void> {
  queueState.value = await fetchQueue();
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const task = await apiCreateTask(input);
  tasks.value = [task, ...tasks.value];
  return task;
}

export async function patchTask(id: string, patch: Partial<CreateTaskInput & { status: TaskStatus }>): Promise<Task> {
  const updated = await apiPatchTask(id, patch);
  tasks.value = tasks.value.map((t) => (t.id === id ? updated : t));
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

export function groupTasksByStatus(taskList: Task[]): Record<TaskStatus, Task[]> {
  const groups: Record<TaskStatus, Task[]> = {
    pending: [],
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
