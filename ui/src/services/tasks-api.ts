export type TaskStatus =
  'pending' | 'ready' | 'running' | 'waiting_on_user' | 'blocked' | 'done' | 'failed' | 'cancelled';

export type TriggerType = 'manual' | 'chat' | 'cron_once' | 'cron_repeat' | 'webhook';

export interface PlanStep {
  step: string;
  done: boolean;
}

export interface Task {
  id: string;
  workspaceId: string | null;
  title: string;
  description: string | null;
  outcome: string | null;
  status: TaskStatus;
  assignedTo: 'user' | 'agent' | null;
  dueAt: string | null;
  expiresAt: string | null;
  triggerType: TriggerType;
  triggerConfig: unknown | null;
  trackerType: string | null;
  trackerId: string | null;
  plan: PlanStep[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskQueueEntry {
  id: string;
  taskId: string;
  status: 'pending' | 'running' | 'paused' | 'done' | 'failed';
  position: number;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  recoveryAttempts: number;
}

export interface QueueState {
  queue: (TaskQueueEntry & { task: Task | null })[];
  running: (TaskQueueEntry & { task: Task }) | null;
  paused: boolean;
}

export interface CreateTaskInput {
  title: string;
  workspaceId?: string | null;
  description?: string | null;
  outcome?: string | null;
  assignedTo?: 'user' | 'agent' | null;
  dueAt?: string | null;
  expiresAt?: string | null;
  triggerType?: TriggerType;
  triggerConfig?: unknown | null;
  trackerType?: string | null;
  trackerId?: string | null;
  plan?: PlanStep[] | null;
}

export interface TaskFilters {
  workspace_id?: string | null;
  status?: TaskStatus;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchTasks(filters: TaskFilters = {}): Promise<Task[]> {
  const params = new URLSearchParams();
  if (filters.workspace_id !== undefined) {
    params.set('workspace_id', filters.workspace_id === null ? 'null' : filters.workspace_id);
  }
  if (filters.status !== undefined) {
    params.set('status', filters.status);
  }
  const qs = params.toString();
  return request<Task[]>(`/api/v1/tasks${qs ? `?${qs}` : ''}`);
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  return request<Task>('/api/v1/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function patchTask(
  id: string,
  patch: Partial<CreateTaskInput & { status: TaskStatus }>,
): Promise<Task> {
  return request<Task>(`/api/v1/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function deleteTask(id: string): Promise<void> {
  await fetch(`/api/v1/tasks/${id}`, { method: 'DELETE' });
}

export async function fetchQueue(): Promise<QueueState> {
  return request<QueueState>('/api/v1/tasks/queue');
}

export async function enqueueTask(id: string): Promise<TaskQueueEntry> {
  return request<TaskQueueEntry>(`/api/v1/tasks/${id}/enqueue`, { method: 'POST' });
}

export async function generatePlan(taskId: string): Promise<PlanStep[]> {
  return request<PlanStep[]>(`/api/v1/tasks/${taskId}/generate-plan`, { method: 'POST' });
}

export async function generatePlanForNewTask(input: {
  title: string;
  description?: string | null;
  workspaceId?: string | null;
}): Promise<PlanStep[]> {
  return request<PlanStep[]>('/api/v1/tasks/generate-plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}
